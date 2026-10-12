---
title: "HTTP range requests: resumable downloads and video seeking, explained"
description: "What Accept-Ranges, Range, Content-Range, 206 Partial Content and 416 are for, why download managers and video players live on them, how If-Range makes a resumable download safe, why generated responses often can't do ranges, and how to enable it (and what breaks it) in nginx."
pubDate: 2026-12-23
lang: en
translationKey: http-range-requests
tags: [networking, nginx]
featured: false
keywords:
  - HTTP range requests
  - 206 Partial Content
  - resumable download
  - Accept-Ranges
  - Content-Range
---

Every time I pause a 4 GB Linux ISO in my browser, close the laptop, and pick it up the next day, I am trusting one small piece of HTTP: the **HTTP range request**. Every time I drag the progress bar in a video and it plays instantly from the blob in the middle of the file instead of re-downloading, it is the same mechanism. It is one of the least glamorous parts of the protocol and one of the most load-bearing — CDNs, package managers, backup tools, and video players all lean on it. This is what the headers mean, what a **resumable download** actually sends, and why copy-pasting a URL into a tool that "just streams" can quietly break seeking.

I ran everything below against a throwaway nginx serving one 2120-byte text file on `127.0.0.1:18080`, plus a tiny generated-response server on `127.0.0.1:18081`, so the headers and status codes are real. If you want the response-side caching story that sits next to this one, see [HTTP caching](/posts/http-caching/).

## Accept-Ranges, Range, Content-Range, 206 and 416 in one breath

Five things do all the work:

- **`Accept-Ranges: bytes`** — the server announcing it can serve a *portion* of the file.
- **`Range: bytes=100-199`** — the client asking for bytes 100 through 199.
- **`206 Partial Content`** — the status code meaning "here is that slice, not the whole thing."
- **`Content-Range: bytes 100-199/2120`** — the slice's place in the whole file: start, end, total size.
- **`416 Requested Range Not Satisfiable`** — "you asked for bytes that do not exist here."

A plain `GET` advertises the capability. nginx enables byte ranges for static files by default, so the `Accept-Ranges: bytes` header just shows up:

```text
$ curl -si http://127.0.0.1:18080/report.txt
HTTP/1.1 200 OK
Server: nginx/1.31.6
Content-Type: text/plain
Content-Length: 2120
Last-Modified: Mon, 12 Oct 2026 10:31:45 GMT
ETag: "6accb711-848"
Accept-Ranges: bytes

line 01: the quick brown fox jumps over the lazy dog
```

That one header is the whole invitation. A client that sees it and wants only part of the file can ask for exactly that.

## A byte range is just an offset — and back comes a 206

Send an explicit `Range` and the server answers `206 Partial Content`, with a body of exactly 100 bytes instead of 2120:

```text
$ curl -si -H 'Range: bytes=100-199' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Server: nginx/1.31.6
Content-Type: text/plain
Content-Length: 100
Last-Modified: Mon, 12 Oct 2026 10:31:45 GMT
ETag: "6accb711-848"
Content-Range: bytes 100-199/2120

y dog
line 03: the quick brown fox jumps over the lazy dog
line 04: the quick brown fox jumps over t
```

Two details matter. `Content-Range` echoes where the slice came from and how big the whole file is — `100-199/2120`. And the offset is zero-based, so `bytes=100-199` is *not* 100 bytes starting at the 100th character you can see; it starts at byte 100 and the byte at offset 100 is the `y` in `lazy`. Getting an off-by-one here is a classic bug in hand-rolled download code.

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="A file from byte 0 to byte 2120 drawn as a horizontal bar. A highlighted band covers bytes 100 to 199 and is labelled Range: bytes=100-199. An arrow points from the band to a response box labelled 206 Partial Content with Content-Range: bytes 100-199/2120 and Content-Length: 100.">
  <g font-family="ui-monospace, monospace" font-size="13" fill="currentColor">
    <text x="10" y="30" font-size="14">File on the server — 2120 bytes</text>

    <rect x="10" y="46" width="680" height="46" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="16" y="74" font-size="12" fill-opacity="0.7">byte 0</text>
    <text x="640" y="74" font-size="12" fill-opacity="0.7">byte 2120</text>

    <rect x="42" y="46" width="32" height="46" fill="#0f766e" fill-opacity="0.85"/>
    <text x="34" y="120" font-size="12" fill-opacity="0.85">100</text>
    <text x="66" y="120" font-size="12" fill-opacity="0.85">199</text>
    <text x="34" y="140" fill="#0f766e" font-weight="bold">Range: bytes=100-199</text>

    <line x1="58" y1="146" x2="58" y2="176" stroke="#0f766e" stroke-width="1.6"/>
    <path d="M52 170 L58 180 L64 170" fill="none" stroke="#0f766e" stroke-width="1.6"/>

    <rect x="120" y="184" width="470" height="56" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="134" y="206" fill="#0f766e" font-weight="bold">206 Partial Content</text>
    <text x="134" y="226" fill-opacity="0.85">Content-Range: bytes 100-199/2120   ·   Content-Length: 100</text>
  </g>
</svg>
<figcaption>A single range maps one slice of the file (green) to one <code>206</code> response. The <code>Content-Range</code> header is how the client knows where that slice belongs.</figcaption>
</figure>

## Why download managers and video players depend on this

Two everyday features fall directly out of ranges.

**Resumable downloads.** A download manager downloading a 4 GB file does not need to start over when the connection drops. It keeps what it already wrote, then asks for the rest. `curl -C -` does exactly this — it reads the size of the partial file and turns it into a `Range` header:

```text
$ curl -s -r 0-399 -o partial.bin http://127.0.0.1:18080/report.txt
$ curl -sv -C - -o partial.bin http://127.0.0.1:18080/report.txt
> GET /report.txt HTTP/1.1
> Host: 127.0.0.1:18080
> Range: bytes=400-
> User-Agent: curl/8.22.0
> Accept: */*

< HTTP/1.1 206 Partial Content
< Content-Type: text/plain
< Content-Length: 1771
< ETag: "6accb735-87b"
```

`Range: bytes=400-` has no end offset, so it means "from byte 400 to the end." The two pieces join back together byte-for-byte, which is the actual test: after resuming, `cmp partial.bin report.txt` says `identical`.

**Video seeking.** Video players don't download a whole file before playing. They request the beginning, start playback, and when you scrub forward they issue a fresh range for the new offset — that is what the "seek" is. Without `Accept-Ranges`, the player can only download linearly, and dragging the bar either does nothing or forces a full re-fetch. This is also why MP4 "faststart" matters: players want the index (`moov` atom) near byte 0 so they can figure out *which* byte range to ask for.

## If-Range: making resumption safe when the file changes

Resumption has a nasty failure mode. You download half of `app.tar.gz`, the server publishes a new build with the same URL, and your manager happily downloads bytes 500 MB onward *of the new file* and staples them onto the *old* first half. You now have a corrupted archive that passes no checksum and makes no sense.

`If-Range` closes that hole. You send your cached validator — the **`ETag`** or **`Last-Modified`** from when you started — alongside the range. If the validator still matches, you get `206`. If the file changed, the server ignores the range and sends `200` with the **whole new file**, so you are forced to restart cleanly instead of corrupting.

Here is the match case, using the `ETag` from the original response:

```text
$ curl -si -H 'Range: bytes=0-9' -H 'If-Range: "6accb711-848"' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-9/2120
Content-Length: 10
ETag: "6accb711-848"
```

And here is what happens when I append a line to the file and send the now-stale `ETag` — note the status flips to `200` and the body is the full new 2171-byte file:

```text
$ curl -si -H 'Range: bytes=0-9' -H 'If-Range: "6accb711-848"' http://127.0.0.1:18080/report.txt
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 2171
ETag: "6accb735-87b"
```

That is the contract: `If-Range` is the difference between "resume blindly" and "resume only if it is still the same file." If you build a downloader, always store the validator next to the partial bytes.

## Why a generated response usually can't do ranges

Not every `200` supports ranges, and it is usually because the response is produced on the fly. A dynamic handler streamed through Python with no stored length:

```text
$ curl -si -H 'Range: bytes=100-199' http://127.0.0.1:18081/
HTTP/1.1 200 OK
Server: BaseHTTP/0.6 Python/3.14.7
Content-Type: text/plain
Transfer-Encoding: chunked
X-Generator: dynamic-no-ranges

line 01: the quick brown fox jumps over the lazy dog
```

No `Content-Length`, no `Accept-Ranges`, and a `Transfer-Encoding: chunked` body — and `curl -r 100-199` reports `http=200 size_download=2120`, i.e. the server handed over the *entire* body and ignored the range. That is legal: a server may ignore `Range` and reply `200`. But now your download manager can't resume it, and your video player can't seek it.

To support ranges on generated content you have to know the total length up front and be able to regenerate any offset deterministically, then implement the slicing (or let a framework's `send_file`-style helper do it). If the content is genuinely open-ended — an event stream, an LLM token stream, a live log tail — ranges simply do not apply, and **streaming is the correct answer**, not a fallback. A stream says "here it comes as it is produced"; a range says "give me a specific window of a thing whose size I know."

## Enabling it in nginx, and what quietly breaks it

For static files, nginx does this out of the box — there is nothing to enable. `Accept-Ranges: bytes` appears, `Range` is honoured, and a malformed or out-of-bounds range gets a `416`:

```text
$ curl -si -H 'Range: bytes=5000-6000' http://127.0.0.1:18080/report.txt | head -6
HTTP/1.1 416 Requested Range Not Satisfiable
Server: nginx/1.31.6
Content-Type: text/html
Content-Length: 197
Connection: keep-alive
Content-Range: bytes */2120
```

The `Content-Range: bytes */2120` on a `416` is the useful part — it tells a confused client the file's real size so it can retry correctly.

The ways ranges stop working are almost always the ones below, and they are worth knowing because each one looks like "the server can't do ranges" when the real cause is a layer in front of it:

- **Compression.** If gzip is applied, the bytes on the wire are no longer the bytes on disk, and offsets no longer line up. Request the same file with `Accept-Encoding: gzip` on a location that forces `gzip on` and the `206` evaporates:

  ```text
  $ curl -si -H 'Accept-Encoding: gzip' -H 'Range: bytes=100-199' http://127.0.0.1:18080/report.txt.gz | head -8
  HTTP/1.1 200 OK
  Content-Type: text/plain
  Transfer-Encoding: chunked
  ETag: W/"6accb711-848"
  Content-Encoding: gzip
  ```

  You get a `200`, a chunked body, a weak `ETag`, and no `Accept-Ranges` — nginx deliberately drops range support when it compresses, because a byte range of the compressed stream means nothing to the client. The practical lesson: never gzip large media or tarballs (it does not help anyway) and do not expect resumable downloads through a compressing layer.
- **Chunked responses / unknown length.** As the Python case showed, no `Content-Length` means nothing to range against.
- **Proxies and caches.** A reverse proxy or CDN that buffers a response and forwards it as chunked, strips `Accept-Ranges`, or drops the `Range` header, breaks resumption for everyone behind it. When a download resumes fine directly but not through your CDN, check the headers at the edge with `curl -I` and compare.
- **The wrong file type for the goal.** Ranges resume *bytes*, not apologies. If a file changes, only `If-Range` saves you.

For a general nginx setup, the [nginx cookbook](/posts/nginx-cookbook/) has the surrounding config this fits into.

## Multi-range requests: several slices in one response

A client can ask for more than one range at once, comma-separated. This is `multipart/byteranges` — a `multipart` body where every part carries its own `Content-Range`:

```text
$ curl -si -H 'Range: bytes=0-9,20-29' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Content-Type: multipart/byteranges; boundary=00000000000000000001
Content-Length: 220

--00000000000000000001
Content-Type: text/plain
Content-Range: bytes 0-9/2120

line 01: t
--00000000000000000001
Content-Type: text/plain
Content-Range: bytes 20-29/2120

rown fox j
--00000000000000000001--
```

Note there is no top-level `Content-Range` anymore — it moved inside each part, and the `boundary` in the `Content-Type` tells the client how to split them. In practice multi-range is rare: players usually fetch one range at a time, and browsers may reject or ignore it. It is worth recognising so it does not look like a corrupted response when a tool does use it.

## Testing with curl -r

The fastest way to check whether a server supports resumption is `curl -r`, which is just `Range` with nicer typing:

- `curl -r 100-199 URL` → the byte range. Confirm you see `206` and the `Content-Range` line.
- `curl -r 100- URL` → open-ended: byte 100 to the end. This is what resuming sends.
- `curl -r -100 URL` → the **last** 100 bytes. Handy for checking a file's tail.
- `curl -sI URL` → look for `Accept-Ranges: bytes` on the `HEAD` before you even download anything.
- `curl -C - -o file URL` → resume into an existing partial file; check it sends `Range: bytes=<size>-`.

Do this against the origin *and* through the proxy/CDN in front of it. If the origin says `Accept-Ranges: bytes` and the edge does not, you have found why downloads restart behind the CDN. Range requests are small headers doing enormous work, and the failures are almost never in the ranges themselves — they are in everything the response passes through on the way out.
