---
title: "brotli vs gzip, measured: HTTP compression on real files, level by level"
description: "brotli vs gzip, measured on real files: full gzip 1-9 and brotli 1-11 byte tables, compression-level CPU costs, nginx gzip and brotli setup, precompressed static assets, BREACH, and what not to compress."
pubDate: 2027-01-27
lang: en
translationKey: http-compression-brotli-vs-gzip
tags: [nginx, networking]
featured: false
keywords:
  - brotli vs gzip
  - HTTP compression
  - Content-Encoding
  - nginx gzip
  - compression level
---

Every HTML page you ship is a pile of very repetitive text, and **HTTP compression** throws most of the repetition away on the wire. The client says which codecs it understands in `Accept-Encoding`, the server picks one per response, and the response comes back with a `Content-Encoding` header saying what was applied. Two codecs matter today: **gzip**, fast and universally supported, and **brotli**, slower to compress but routinely 10–18% smaller on web text. People repeat those numbers at each other without measuring, so I measured. Every figure below comes from real `gzip` and `brotli` runs on real files, and from a real nginx container — nothing is illustrative. For the nginx directives themselves I stay out of the way of my [nginx cookbook](/posts/nginx-cookbook/); for how the compressed bytes interact with caches, see [HTTP caching](/posts/http-caching/); and compression is orthogonal to the transport upgrades in [HTTP/2 vs HTTP/1.1](/posts/http2-vs-http11/).

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="HTTP compression negotiation: the client sends a request with an Accept-Encoding header listing gzip and br. The server picks one codec for that response, compresses the body, and answers with Content-Encoding set. The client decompresses and the browser renders the original page. A response with no matching codec is sent identity encoded, without any Content-Encoding header.">
  <defs>
    <marker id="hc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="16" y="70" width="150" height="64" rx="8"/>
    <rect x="285" y="70" width="150" height="64" rx="8"/>
    <rect x="554" y="70" width="150" height="64" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="91" y="98">client</text>
    <text x="91" y="116" font-size="11" opacity="0.75">browser</text>
    <text x="360" y="98">server (nginx)</text>
    <text x="360" y="116" font-size="11" opacity="0.75">picks a codec</text>
    <text x="629" y="98">client</text>
    <text x="629" y="116" font-size="11" opacity="0.75">decompresses</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none">
    <line x1="166" y1="88" x2="283" y2="88" marker-end="url(#hc-arrow)"/>
    <line x1="435" y1="116" x2="552" y2="116" marker-end="url(#hc-arrow)"/>
  </g>
  <g fill="#0f766e" font-family="ui-monospace, monospace" font-size="11.5" text-anchor="middle">
    <text x="224" y="74">Accept-Encoding: gzip, br</text>
    <text x="493" y="142">Content-Encoding: br</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.4" fill="none" opacity="0.85">
    <line x1="435" y1="90" x2="470" y2="90"/>
    <line x1="470" y1="90" x2="470" y2="130"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.7" text-anchor="middle">
    <text x="360" y="180">no matching codec → identity: the body is sent as-is, no Content-Encoding</text>
    <text x="360" y="200">compression is per-response and negotiated per-request — never a connection-wide setting</text>
  </g>
</svg>
<figcaption>Content negotiation for compression: the client advertises codecs; the server answers with the one it used.</figcaption>
</figure>

## Where compression sits, and what the headers actually say

Compression lives between the HTTP layer and the wire: the message body is a byte stream, and `Content-Encoding: gzip` or `Content-Encoding: br` tells the receiver how those bytes were produced. Three details matter in practice:

- **It is negotiated, never assumed.** The client sends `Accept-Encoding: gzip, br` (curl sends this only when you ask for it — a bare `curl` gets `identity`). If nothing matches, the server sends the body unchanged with no `Content-Encoding` header at all. I verified this against a live nginx: request with the header → `Content-Encoding: gzip`; request without it → no such header.
- **It is per response.** One response can be gzipped and the next identity encoded on the same connection; nginx decides per file against `gzip_types`.
- **It is not `Transfer-Encoding`.** `Transfer-Encoding: chunked` is about framing, not content; you will see both on a compressed response.

gzip is DEFLATE (LZ77 + Huffman) with a 32 KB window and no dictionary beyond the data itself. Brotli keeps the LZ77 + Huffman core but adds a much larger sliding window, context modeling, and — the part that matters for the web — a **built-in static dictionary of common web tokens** (`<div`, `function`, `stylesheet`, …). That is why its win is biggest on HTML and CSS and smaller on already-minified JavaScript.

## The real numbers: brotli vs gzip on five real files

I compressed the same five real files with `gzip -n -1..-9` and `brotli -q 1..11`: a real blog page fetched from blog.awin-x.top (50,981 B), a real minified bundle (htmx 2.0.4 from jsDelivr, 50,917 B), a real `package-lock.json` (214,466 B), a real stylesheet (18,127 B), and a real PNG this blog serves (246,459 B). `-n`/`--no-name` keeps gzip's output deterministic. Full sweep in bytes:

| file | raw | gzip -1 | gzip -6 | gzip -9 | brotli -1 | brotli -5 | brotli -11 |
|---|---|---|---|---|---|---|---|
| page.html | 50,981 | 12,451 | 10,819 | 10,784 | 12,247 | 10,084 | **8,880** |
| bundle.js | 50,917 | 19,259 | 16,350 | 16,314 | 18,951 | 15,933 | **14,802** |
| data.json | 214,466 | 51,908 | 45,486 | 44,799 | 47,711 | 41,849 | **39,510** |
| styles.css | 18,127 | 5,469 | 4,486 | 4,454 | 5,677 | 4,309 | **3,872** |
| moire PNG | 246,459 | 246,213 | 246,194 | 246,194 | — | 246,467 | 246,464 |
| photo.jpg | 87,397 | 86,579 | 86,485 | 86,485 | — | 86,232 | 85,763 |

What I read off the table:

- **Against gzip's default level 6, brotli at max quality is 9.5% (JS) to 17.9% (HTML) smaller.** The dictionary earns its keep on HTML: 8,880 vs 10,819 bytes for the same page.
- **gzip's top levels are nearly pointless.** `gzip -9` beats `gzip -6` by 0.3% on the page and 1.5% on the JSON. Going from `-1` to `-6` buys 13% — the level curve is steep at the start and flat at the top.
- **Brotli -1 is not a "fast brotli".** On the CSS it is *bigger* than `gzip -1` (5,677 vs 5,469). If you want fast, pick gzip at a low level or precompress (below).
- **The already-compressed files barel budge.** The PNG loses 0.1% at gzip -6 and at brotli -11 is five bytes *larger* than the original; the real photo JPEG shrinks about 1% under either codec. That is the signature of a file that is already entropy-coded — more on that below.

One caveat, because honesty beats tidiness: this blog's 512×512 RGBA icon (18,507 B) *does* gzip to 15,407 B — 16.7%. The cause is the alpha channel plus an encoder that did not max out DEFLATE, not some magical property of the format. It is the exception; the noise-dominated render above is the rule.

## Compression levels are a CPU/size dial, and brotli's top end is expensive

Levels trade encode CPU for size. I timed each codec on the same files, min of three runs on one small core (process startup included, so treat absolute values as rough — the ratios are the point):

| file | gzip -1 | gzip -6 | gzip -9 | brotli -4 | brotli -11 |
|---|---|---|---|---|---|
| page.html | 2.7 ms | 3.1 ms | 3.5 ms | 3.6 ms | 90.4 ms |
| data.json | 4.8 ms | 7.4 ms | 14.1 ms | 7.7 ms | 415.5 ms |
| moire PNG | 9.7 ms | 10.5 ms | 10.5 ms | 4.0 ms | 256.9 ms |

Two things stand out. First, **brotli's quality scale is not linear in effort**: `-q 11` costs an order of magnitude or more versus gzip -6 for the size win in the table. Second, compressing *incompressible* data still burns CPU — the PNG row is pure waste either way, which is exactly why you never point a general-purpose compressor at images on the request path. Decompression, by contrast, is cheap for both codecs; the cost lives entirely on the producing side.

## What not to compress: already-encoded bytes, and secrets

If a payload has already been entropy-coded — JPEG, PNG, WebP, AVIF, MP4, gzips, WOFF2 — there is nothing left to squeeze, and the "compression" step only adds latency andCPU. My measurements above are the evidence: 0.1% on a noise-dominated PNG, ~1% on a real photo. This is also why nginx's `gzip_types` defaults to text types and why I deliberately left `image/png` and `image/jpeg` out of my config — the live server answered `photo.png` with a full 246,459-byte body and no `Content-Encoding`.

The security note is the one people forget: **CRIME attacked request compression; BREACH attacks response compression.** If a server compresses a response that contains both a secret (a CSRF token, a session value) and user-controlled input reflected back, the attacker recovers the secret byte by byte by watching ciphertext lengths across many requests — compression reveals how close their guess was. Practically: never enable response compression on endpoints that reflect user input alongside a per-user secret, or add per-request masking so lengths carry no signal. A static, non-personalized site like this one has no reflection surface and is not in BREACH's blast radius; a dynamic JSON API might be.

## Enabling it in nginx — honestly

The `gzip` module is built into stock nginx, so on any official image this is the whole story:

```bash
$ docker run -d --name ngxgz -p 127.0.0.1:8080:8080 \
    -v "$PWD/gzip.conf":/etc/nginx/conf.d/default.conf:ro \
    -v "$PWD/site":/srv/site:ro nginx:1.27-alpine
```

```nginx
server {
    listen 8080;
    root /srv/site;

    gzip on;
    gzip_comp_level 6;          # the default; -9 buys ~1% for ~2x CPU
    gzip_min_length 256;        # don't bother with tiny bodies
    gzip_vary on;               # add "Vary: Accept-Encoding" for proxy caches
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
    # text/html is always compressed; images are never in this list
}
```

And the real capture from that container:

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8080/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
Transfer-Encoding: chunked
ETag: W/"6acee911-c725"
Content-Encoding: gzip
Vary: Accept-Encoding

size_download=10799 time_total=0.002300

$ curl -s -o /dev/null -w 'size_download=%{size_download}\n' http://127.0.0.1:8080/
size_download=50981     # no Accept-Encoding sent: identity, no Content-Encoding
```

The 51 KB page crosses the wire as 10,799 bytes. **Brotli in nginx is a different story, and here is the honest part: stock nginx cannot serve brotli.** The codec needs Google's `ngx_brotli` third-party module (`--add-module=...` at compile time), which no official image includes. For this post I ran a real third-party build — `nginx/1.30.4` from the `fholzer/nginx-brotli` image, compiled with `--add-module=/usr/src/ngx_brotli` — purely to capture what `Content-Encoding: br` actually looks like:

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: br' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8082/
HTTP/1.1 200 OK
Server: nginx/1.30.4
Content-Type: text/html
Transfer-Encoding: chunked
ETag: W/"6acee911-c725"
Content-Encoding: br

size_download=8880 time_total=0.083235
```

Same page, 8,880 bytes (17.9% under gzip's 10,799) — and 83 ms instead of 2.3 ms. On the 214 KB JSON the gap is starker: gzip served 45,272 bytes in 5.5 ms; on-the-fly brotli -11 served 39,510 bytes in 564 ms. That is the whole trade in two numbers: better ratio, hundredfold CPU, which is an availability problem the moment responses are dynamic and traffic is real. (I also confirmed negotiation priorities: a request with `Accept-Encoding: gzip, deflate, br` gets `br`.)

While testing I caught a subtlety worth passing on. That image's base config sets `brotli_static on` at the `http` level, and a stale `bundle.js.br` on disk was being served pre-compressed in 0.55 ms while I thought I was measuring on-the-fly brotli. I only noticed because 51 KB of JavaScript does not compress in half a millisecond; after moving the `.br` away, the same request took 88 ms. If your numbers look too good, check which code path produced them.

## Precompressing static assets: the option I actually use

For static content the best answer sidesteps the CPU question entirely: compress once at build time, serve the compressed file with zero runtime cost. nginx's `gzip_static` (in official builds) and brotli builds' `brotli_static` look for `file.ext.gz` / `file.ext.br` next to the original and serve them with the right `Content-Encoding` when the client accepts it — falling back to the original when it does not:

```nginx
server {
    listen 8080;
    root /srv/site;
    gzip off;          # nothing is compressed per-request
    gzip_static on;    # serve bundle.js.gz when Accept-Encoding allows
}
```

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8081/bundle.js
HTTP/1.1 200 OK
Content-Type: application/javascript
Content-Length: 16314
ETag: "6acee947-3fba"
Content-Encoding: gzip
Accept-Ranges: bytes

size_download=16314 time_total=0.000900
```

The same file served from `bundle.js.br` on the brotli build: `Content-Encoding: br`, 14,802 bytes, 0.0008 s. Brotli's ratio at gzip's response speed — that is the sweet spot for a static site, and it is why my build pipeline should be emitting `.br` next to every asset it already `.gz`s. Keep on-the-fly `gzip on` behind it as the safety net for anything not precompressed, and remember the fallback rule: if neither codec is accepted, the original bytes go out untouched.

## So: brotli or gzip — is it worth it?

Measured, the honest answer is layered:

- **gzip at default settings: yes, obviously.** 51 KB → 10.8 KB for ~3 ms of CPU is free money, and support is universal.
- **On-the-fly brotli -11 on dynamic content: usually no.** 10–18% fewer bytes for an order of magnitude more encode CPU per response is a bad trade under load, and stock nginx can't do it anyway without a third-party module you now have to maintain.
- **Precompressed brotli for static assets: yes, this is the win.** 14,802 vs 16,314 bytes — brotli's extra 9% over precompressed gzip — at identical ~0.6 ms serving cost, with the build eating the CPU once.
- One calibration note from the loopback tests above: on a local link the gzip response was *slower* than identity (2.3 ms vs 0.7 ms), because there is no WAN to save. Compression wins exactly where bytes are expensive; on a 40 ms-RTT mobile link, 13% fewer bytes is the difference.

The config I ship is therefore: `gzip_static on` + `gzip on` at level 6 with `gzip_vary` for the leftovers, `.gz` and `.br` emitted at build time, images excluded, and no runtime brotli. Everything above was run for real — same files, same container, real headers — and that is the whole story of **brotli vs gzip** in production.
