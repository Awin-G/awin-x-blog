---
title: "HTTP conditional requests: ETag, 304 Not Modified, and saving bandwidth the right way"
description: "Conditional requests let a client ask 'has this changed?' before downloading a body. Real curl output against a throwaway nginx: ETag + If-None-Match returning 304 Not Modified with zero body bytes, If-Modified-Since vs ETag, If-Match returning 412, and Range returning 206."
pubDate: 2027-01-22
lang: en
translationKey: http-conditional-requests
tags: [networking, nginx]
featured: false
keywords:
  - HTTP conditional requests
  - ETag
  - 304 Not Modified
  - If-None-Match
  - Last-Modified
---

Every browser you have ever used has asked the same question before downloading a file: "has this changed since I last fetched it?" That question is the heart of **HTTP conditional requests** — the client sends a validator it already holds, and the server answers with the full representation or a tiny `304 Not Modified` meaning "no, keep your copy." The two validator pairs are `ETag` / `If-None-Match` (content-based, strong) and `Last-Modified` / `If-Modified-Since` (time-based, weaker). I ran a throwaway nginx on `127.0.0.1` and captured real `curl -i` output for every case — the first `200`, the conditional `304`, a `412 Precondition Failed` from `If-Match`, a `206` from a `Range request` — with the bytes saved measured on the wire. For theory, see [HTTP caching](/posts/http-caching/); here we stay on the wire.

## What HTTP conditional requests actually are

A normal `GET` is unconditional: the server sends the full body even if the client has an identical copy from ten seconds ago. A conditional request turns the question around — "only give me the body if this condition holds." Reads use `If-None-Match: <etag>` ("send it unless the current ETag matches") and `If-Modified-Since: <date>` ("send it unless it changed since this date"); writes use `If-Match: <etag>` and `If-Unmodified-Since: <date>` ("apply my write only if it still looks like the version I read"). The server answers with the full `200 OK` body, a bodyless `304 Not Modified`, or — for writes — a `412 Precondition Failed`.

## ETag and If-None-Match: the validator pair that saves the body

An `ETag` is an opaque token the server attaches to a representation; the client echoes it back in `If-None-Match`. First request against my throwaway nginx, serving a 180,000-byte file:

```console
$ curl -s -D - -o /dev/null http://127.0.0.1:8080/payload.txt
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:13 GMT
Content-Type: text/plain
Content-Length: 180000
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
Accept-Ranges: bytes
```

Note the default ETag format `"<hex mtime>-<hex size>"` (`2bf20` = 180000 in hex) and that the response carries both validators. Now the conditional request, sending the ETag back:

```console
$ curl -s -D - -o /dev/null -H 'If-None-Match: "6acd98cd-2bf20"' http://127.0.0.1:8080/payload.txt
HTTP/1.1 304 Not Modified
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:47 GMT
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
```

No `Content-Length`, no body — the response ends after the headers.

## 304 Not Modified: the response that costs almost nothing

A `304 Not Modified` is the whole point: the server confirms "your copy is still good" without re-sending a single byte. It may carry updated validators and freshness headers so the client can refresh its cache metadata, but there is no body and no `Content-Length`. Measured with `curl -w`:

```console
$ curl -s -o /dev/null -w 'body=%{size_download} header=%{size_header}\n' http://127.0.0.1:8080/payload.txt
body=180000 header=244
$ curl -s -o /dev/null -w 'body=%{size_download} header=%{size_header}\n' -H 'If-None-Match: "6acd98cd-2bf20"' http://127.0.0.1:8080/payload.txt
body=0 header=182
```

180,000 body bytes down to zero, per poll. For a dashboard polling an API every five seconds, or a CDN edge revalidating a popular asset, that is the difference between a bandwidth bill and noise.

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="First request downloads 180000 bytes; a conditional request with If-None-Match downloads 0 bytes">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="8" y="8" width="296" height="224" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="156" y="34" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="currentColor">1. First request</text>
  <text x="40" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">GET /payload.txt</text>
  <line x1="40" y1="94" x2="272" y2="94" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="40" y="132" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">200 OK</text>
  <text x="40" y="152" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">body: 180,000 B</text>
  <line x1="272" y1="164" x2="40" y2="164" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <rect x="336" y="8" width="296" height="224" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="484" y="34" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="currentColor">2. Conditional request</text>
  <text x="368" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">GET + If-None-Match</text>
  <line x1="368" y1="94" x2="600" y2="94" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="368" y="132" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">304 Not Modified</text>
  <text x="368" y="152" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">body: 0 B</text>
  <line x1="600" y1="164" x2="368" y2="164" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="484" y="212" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="#0f766e">180,000 B saved per poll</text>
</svg>
<figcaption>The first request pays for the full body; the conditional request pays for headers only.</figcaption>
</figure>

## Last-Modified and If-Modified-Since: the older, weaker sibling

The time-based pair works the same way: echo the stored `Last-Modified` in `If-Modified-Since` and an unchanged resource gets the same bodyless `304`:

```console
$ curl -s -D - -o /dev/null -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:53 GMT' http://127.0.0.1:8080/payload.txt
HTTP/1.1 304 Not Modified
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:47 GMT
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
```

Why is `ETag` stronger? Three reasons:

1. **One-second resolution.** HTTP dates have second granularity; a file saved twice within one second is "unchanged" to `If-Modified-Since` but changed to any content-based `ETag`.
2. **Mtime is fragile.** `rsync`, `git checkout`, or a redeploy can bump mtime without changing content — or preserve it while content changes. A content-derived ETag survives both.
3. **No clock dependency.** `If-Modified-Since` compares two clocks; ETags compare tokens.

nginx also tunes how strict the date comparison is. The default `if_modified_since exact` requires the date to match `Last-Modified` to the second; with `before`, any date at or after the mtime also yields `304`. Same file, same request, date one second later:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:54 GMT' http://127.0.0.1:8080/payload.txt
200
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:54 GMT' http://127.0.0.1:8080/lenient/payload.txt
304
```

The second location sets `if_modified_since before;`. Reach for it when clients round or pad timestamps — but it is *more* lenient than the RFC requires, and can mask a real change inside that second.

## If-Match and 412: optimistic concurrency for writes

Conditional requests are not just for reads. When you update a resource you can say "only apply this if it still looks like the version I read" — that is `If-Match`, and it stops two editors from silently overwriting each other. The server compares `If-Match` against the current ETag: match, the write proceeds; mismatch, you get `412 Precondition Failed` and nothing is written.

nginx's WebDAV module does not evaluate `If-Match` (I checked the 1.27.5 source), so this demo uses a tiny throwaway reference server on `127.0.0.1:8081`:

```console
$ curl -s -i -X PUT -d 'x' -H 'If-Match: "wrong-etag"' http://127.0.0.1:8081/payload.txt
HTTP/1.1 412 Precondition Failed
Server: BaseHTTP/0.6 Python/3.13.16
Date: Tue, 13 Oct 2026 02:41:08 GMT
Content-Type: text/plain
Content-Length: 67

Precondition Failed: If-Match ETag does not match current resource
```

Matching cases behave as expected — `If-Match: *` and the correct ETag succeed; a missing `If-Match` gets `428`:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' -H 'If-Match: *' http://127.0.0.1:8081/payload.txt
204
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' -H 'If-Match: "6acd98cd-2bf20"' http://127.0.0.1:8081/payload.txt
204
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' http://127.0.0.1:8081/payload.txt
428
```

The check is a strong comparison: split on commas, strip whitespace, accept `*` or an exact match. In production this lives in your framework (Rails, Django, Spring all have it); wired into nginx, `if ($http_if_match != '"..."') { return 412; }` covers a single known ETag. `If-Unmodified-Since` is the date-based sibling, with the same one-second caveat.

## Range requests and 206: resumable downloads

A `Range request` asks a different question — not "has it changed?" but "give me only these bytes." nginx answers `206 Partial Content` with a `Content-Range` header saying what slice arrived:

```console
$ curl -s -D - -o /dev/null -H 'Range: bytes=0-99' http://127.0.0.1:8080/payload.txt
HTTP/1.1 206 Partial Content
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:37:37 GMT
Content-Type: text/plain
Content-Length: 100
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
Content-Range: bytes 0-99/180000
```

100 bytes instead of 180,000 — measured `body=100 header=266`. This is what makes downloads resumable (curl `-C -`) and lets a video player seek without buffering the whole file. The mechanisms compose: `If-Range` conditions a range request on the ETag, so a resumed download that lands on a changed file gets a full `200` instead of a silently wrong slice. For full nginx tuning, see the [nginx cookbook](/posts/nginx-cookbook/).

## How nginx (and CDNs) handle conditional requests

Out of the box nginx does almost everything right: it emits `ETag` and `Last-Modified` for static files, honors `If-None-Match` and `If-Modified-Since`, and advertises `Accept-Ranges: bytes`. The two knobs you will touch:

```nginx
server {
    listen 8080;
    root /srv/www;

    location /noetag/ {
        etag off;                  # drop ETag, keep Last-Modified
    }

    location /lenient/ {
        if_modified_since before;  # 304 even when mtime < given date
    }
}
```

`etag off` is the more interesting one. With it, the same file comes back with no `ETag` at all — only `Last-Modified` remains as a validator:

```console
$ curl -s -D - -o /dev/null http://127.0.0.1:8080/noetag/noetag.txt
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:40:51 GMT
Content-Type: text/plain
Content-Length: 180000
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
Accept-Ranges: bytes
```

That is legitimate behind a load balancer that rewrites responses, but it silently downgrades every client to the weaker validator. CDNs cache the *validators*, not just the bodies: an edge node can answer `If-None-Match` with a cached `304`, so even header bytes never cross the backbone; the origin is asked only when the edge's copy is genuinely stale.

## Common mistakes I see in the wild

**Generating ETags from mtime alone.** nginx's default `"<hex mtime>-<hex size>"` is already mtime-based; a hand-rolled mtime-only ETag is worse. Two backends serving identical content produce different ETags, so a load-balanced client gets cache misses and extra `200`s. Hash the content, or include size and inode.

**Weak ETags where strong ones are required.** A weak ETag (`W/"..."`) means "semantically equivalent," not "byte-identical." Fine for `If-None-Match` on a `GET`, but never with `If-Match` on a write or `If-Range` — a resumed download of a "semantically equivalent" file could be corrupt.

**Caches serving stale 304s.** A `304` is only as trustworthy as the validator behind it. If your origin computes ETags from mtime and deploys touch files without changing them, clients get `304` forever and never see the new content. Log the validator you send and diff it against the content hash.

**Treating 304 as "the request worked" in health checks.** A `304` means "your cached copy is fine," which says nothing about whether a *fresh* client would get the right bytes. Probe with a cold request when you need ground truth.

## The takeaway

Conditional requests are the difference between "download everything, always" and "prove it changed." Send `If-None-Match` with the `ETag` you stored and you get a bodyless `304 Not Modified` — 180,000 bytes saved per poll in my measurements, the same math at CDN scale. Keep `Last-Modified`/`If-Modified-Since` as fallback, use `If-Match` for writes, and reach for `Range` when you only need part of the file. The validators are small; the bandwidth they save is not.
