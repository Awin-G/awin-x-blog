---
title: "nginx proxy_cache in practice: caching your upstream for real"
description: "A hands-on walkthrough of nginx proxy_cache: real MISS→HIT requests against a counting origin, X-Cache-Status debugging, cache keys, bypass, stale-while-error, and the risks OSS nginx won't save you from."
pubDate: 2027-01-09
lang: en
translationKey: nginx-proxy-cache
tags: [nginx, devops]
featured: false
keywords:
  - nginx proxy_cache
  - X-Cache-Status
  - proxy_cache_path
  - cache HIT MISS
  - cache key
---

# nginx proxy_cache in practice: caching your upstream for real

Every nginx config I write in front of a small upstream eventually hits the same question: why is my app serving the same JSON or HTML over and over when nginx could just remember it? That is what `proxy_cache` is for — a shared, on-disk cache that lives inside nginx itself, sitting between your clients and your upstream.

It is not browser caching. Browser caching (`Cache-Control`, `ETag`, `Last-Modified`) keeps a copy on each client; `proxy_cache` keeps one copy on the server that every client shares. If you have read [HTTP caching](/posts/http-caching/) you know the header-driven half of the story — this post is the nginx half, and I am going to show it with real requests against a real (tiny) origin, not with screenshots from a tutorial.

By the end you will have seen a genuine cache HIT/MISS cycle, the `X-Cache-Status` header doing its job, cache keys that include query strings and cookies, `proxy_cache_bypass` and `proxy_no_cache`, `proxy_cache_use_stale`, and the honest truth about purging in nginx OSS.

## The idea in one diagram

<figure>
  <svg viewBox="0 0 680 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="cache-diagram-title" style="max-width:100%;height:auto">
    <title id="cache-diagram-title">A client sends a request to nginx; nginx serves it from its on-disk cache on a HIT, or fetches it from the origin on a MISS</title>
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <rect x="20" y="70" width="150" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="95" y="112" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">Client</text>
    <text x="95" y="136" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">browser / curl</text>
    <rect x="265" y="40" width="180" height="160" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="355" y="68" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">nginx</text>
    <rect x="285" y="82" width="140" height="56" rx="8" fill="#0f766e" fill-opacity="0.12" stroke="#0f766e" stroke-width="1.5"/>
    <text x="355" y="106" text-anchor="middle" fill="currentColor" font-size="13" font-family="system-ui, -apple-system, sans-serif">proxy_cache</text>
    <text x="355" y="124" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">on disk + keys in RAM</text>
    <text x="355" y="164" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">X-Cache-Status: MISS / HIT</text>
    <rect x="540" y="70" width="120" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="600" y="112" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">Origin</text>
    <text x="600" y="136" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">your app</text>
    <line x1="170" y1="105" x2="260" y2="105" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="215" y="95" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">request</text>
    <line x1="445" y1="105" x2="535" y2="105" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="490" y="95" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">MISS only</text>
    <line x1="535" y1="135" x2="445" y2="135" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="490" y="156" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">response</text>
    <path d="M 265 152 C 210 172, 190 140, 172 128" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow)"/>
    <text x="150" y="196" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">HIT: served from cache</text>
  </svg>
  <figcaption>On a MISS nginx proxies to the origin and stores the response; on a HIT it serves the stored bytes and the origin never sees the request.</figcaption>
</figure>

When a request arrives, nginx checks its cache zone. On a MISS it proxies to the origin and stores the response; on a HIT it serves the stored bytes without touching the origin at all. The origin only ever sees the first request — plus whatever you deliberately bypass.

## The lab: a tiny origin that counts its own requests

To prove caching actually happens, the origin needs to count. Here is the whole origin — a 30-line Python HTTP server that increments a counter on every request it receives:

```python
"""Throwaway origin for the proxy_cache demo."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

count = 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        global count
        count += 1
        if self.path == "/count":
            body = f"origin has served {count} request(s)\n".encode()
        else:
            body = f"origin served request #{count} path={self.path}\n".encode()

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # NOTE: nginx refuses to cache responses with
        # Cache-Control: no-cache/no-store/private unless you set
        # proxy_ignore_headers. The first demo run sent "no-cache"
        # here and every request was a MISS - so this origin sends
        # no Cache-Control at all and lets proxy_cache_valid decide.
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence per-request logging
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
```

Two throwaway containers on a private Docker network (no sudo, loopback-only ports, official images):

```bash
docker network create cachelab
docker run -d --name origin --network cachelab \
  -v $PWD/origin.py:/app/origin.py:ro \
  python:3-alpine python /app/origin.py
docker run -d --name nginx --network cachelab -p 127.0.0.1:18099:80 \
  -v $PWD/nginx.conf:/etc/nginx/nginx.conf:ro \
  nginx:1.27-alpine
```

The origin listens on `origin:8000` inside the network; nginx is reachable from the host on `127.0.0.1:18099`. Everything below is real output from this lab.

## The config that makes it work

```nginx
worker_processes  1;

error_log  /tmp/error.log warn;
pid        /tmp/nginx.pid;

events {
    worker_connections  1024;
}

http {
    default_type  application/octet-stream;
    sendfile        on;

    # Debugging gold: log the cache decision for every request
    log_format  cache  '$remote_addr [$time_local] "$request"'
                       'status=$status cache=$upstream_cache_status';
    access_log  /tmp/access.log cache;

    # --- the shared, on-disk cache -------------------------------------
    # /tmp/nginx-cache : where response bodies are written on disk
    # levels=1:2       : two directory levels, keeps directories small
    # keys_zone        : 10 MB of shared memory holding ~80k cache keys
    # inactive=60m     : untouched entries are evicted after 60 min
    proxy_cache_path  /tmp/nginx-cache levels=1:2
                      keys_zone=my_cache:10m inactive=60m use_temp_path=off;

    # --- what makes two requests "the same" ---------------------------
    proxy_cache_key  "$scheme$request_method$host$request_uri";

    upstream origin_srv {
        server origin:8000;
    }

    server {
        listen 80;
        server_name _;

        # visible on every response, cached or not
        add_header X-Cache-Status $upstream_cache_status always;

        # the origin's hit counter - bypassed on purpose, otherwise the
        # counter itself would be cached and could never go up again
        location = /count {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_bypass 1;
            proxy_no_cache     1;
        }

        # explicit "never cache this" demo endpoint
        location /bypass {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_bypass 1;
            proxy_no_cache     1;
        }

        # per-user cache: the cookie value becomes part of the key
        location /user {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_key    "$scheme$host$cookie_user$request_uri";
            proxy_cache_valid  200 30s;
        }

        location / {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_valid  200 302 10s;   # demo: very short!
            proxy_cache_valid  404 1m;
            proxy_cache_lock   on;           # one upstream fetch per key
            proxy_cache_use_stale  error timeout http_502 http_503 http_504;
        }
    }
}
```

The four directives that do the heavy lifting:

- `proxy_cache_path` — where the cache lives. `/tmp/nginx-cache` is the on-disk location, `levels=1:2` splits files across two directory levels (keeps directories small), `keys_zone=my_cache:10m` reserves 10 MB of shared memory for cache keys (~80k of them), and `inactive=60m` evicts entries nobody has requested for an hour.
- `proxy_cache my_cache` — turns the zone on for this location.
- `proxy_cache_valid 200 302 10s` — how long a 200/302 response stays fresh. Ten seconds, because this is a demo; in production you would use minutes or hours, or let the origin's `Cache-Control: s-maxage` speak.
- `add_header X-Cache-Status $upstream_cache_status always` — the debugging superpower, more on it below.

## MISS → HIT: watching the origin counter

First request — nginx has nothing stored, so it proxies to the origin and caches the response:

```bash
$ curl -si http://127.0.0.1:18099/api
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 20:26:20 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 35
Connection: keep-alive
X-Cache-Status: MISS

origin served request #1 path=/api
```

Second request, seconds later — same bytes, but the origin is never contacted:

```bash
$ curl -si http://127.0.0.1:18099/api
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 20:26:20 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 35
Connection: keep-alive
X-Cache-Status: HIT

origin served request #1 path=/api
```

The origin's own counter proves it — nginx served the path twice, the origin saw it once:

```bash
$ curl -s http://127.0.0.1:18099/count
origin has served 2 request(s)
```

(Two, not one: the MISS fetch plus this very `/count` request — which is itself deliberately bypassed, more on that below.)

And the access log, with a `log_format` that includes `$upstream_cache_status`, tells the same story:

```
172.19.0.1 [12/Oct/2026:20:26:20 +0000] "GET /api HTTP/1.1" status=200 cache=MISS
172.19.0.1 [12/Oct/2026:20:26:20 +0000] "GET /api HTTP/1.1" status=200 cache=HIT
172.19.0.1 [12/Oct/2026:20:26:28 +0000] "GET /count HTTP/1.1" status=200 cache=BYPASS
```

The response bodies are also on disk, in the `levels=1:2` directory tree:

```bash
$ docker exec nginx ls -laR /tmp/nginx-cache
/tmp/nginx-cache:
total 12
drwx------    3 nginx    root          4096 Oct 12 20:26 .
drwxrwxrwt    1 root     root          4096 Oct 12 20:25 ..
drwx------    3 nginx    nginx         4096 Oct 12 20:26 9

/tmp/nginx-cache/9:
total 12
drwx------    3 nginx    nginx         4096 Oct 12 20:26 .
drwx------    3 nginx    nginx         4096 Oct 12 20:26 ..
drwx------    2 nginx    nginx         4096 Oct 12 20:26 31

/tmp/nginx-cache/9/31:
total 12
drwx------    2 nginx    nginx         4096 Oct 12 20:26 .
drwx------    3 nginx    nginx         4096 Oct 12 20:26 ..
-rw-------    1 nginx    nginx          551 Oct 12 20:26 827f13cf5e5e6860a3c2d3537cb62319
```

One file per cache entry, named by the MD5 of the cache key. 551 bytes for a 35-byte body — the rest is nginx's metadata (key, expiry, headers).

### The gotcha that bit me first

My first origin sent `Cache-Control: no-cache` (to keep browsers honest), and every single request was a MISS:

```
X-Cache-Status: MISS
origin served request #1 path=/api
X-Cache-Status: MISS
origin served request #2 path=/api
```

nginx silently refuses to cache responses carrying `Cache-Control: no-cache`, `no-store`, or `private` unless you add `proxy_ignore_headers Cache-Control;`. The fix in the lab was to let the origin send no `Cache-Control` at all and let `proxy_cache_valid` decide — but in production, `proxy_ignore_headers` (or better, `s-maxage` on the origin) is the knob to know.

## X-Cache-Status: the header that tells you the truth

`$upstream_cache_status` is set on every proxied response, and echoing it as `X-Cache-Status` is the single most useful debugging habit I know for nginx caching:

| Status | Meaning |
| --- | --- |
| `MISS` | Not in cache (or not cacheable); nginx fetched from upstream |
| `HIT` | Served from cache |
| `EXPIRED` | Cached entry went stale; nginx revalidated or refetched |
| `BYPASS` | `proxy_cache_bypass` / `proxy_no_cache` forced a pass-through |
| `STALE` | Served an expired entry because the upstream failed (`proxy_cache_use_stale`) |
| `UPDATING` | Serving stale while a background refresh runs |
| `REVALIDATED` | Upstream confirmed the stale entry with a 304 |

Watching it go through its paces in the lab — after the 10-second validity ran out:

```bash
$ curl -si 'http://127.0.0.1:18099/api?x=1'   # 12 s later
X-Cache-Status: EXPIRED
origin served request #7 path=/api?x=1

$ curl -si 'http://127.0.0.1:18099/api?x=1'   # immediately after
X-Cache-Status: HIT
origin served request #7 path=/api?x=1
```

`EXPIRED` means "the fresh copy is gone, I went upstream and cached the new one" — so the next request is a HIT again. If you see `HIT` where you expected `MISS`, or `MISS` on every request, this header is the first thing to check. My [nginx cookbook](/posts/nginx-cookbook/) has the `log_format` line to put it in your access logs too.

## What's in a cache key

Two requests are "the same" only if their cache keys match. The default key is `$scheme$proxy_host$request_uri` — and `$request_uri` includes the query string, which the lab confirms:

```bash
$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: MISS
origin served request #3 path=/api?x=1

$ curl -si 'http://127.0.0.1:18099/api?x=2'
X-Cache-Status: MISS
origin served request #4 path=/api?x=2

$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: HIT
origin served request #3 path=/api?x=1
```

Different query string → different key → separate cache entry. That is usually what you want, and it is also a poisoning risk (more below).

Keys can be tuned per location. The `/user` endpoint in the lab keys on a cookie:

```nginx
location /user {
    proxy_pass         http://origin_srv;
    proxy_cache        my_cache;
    proxy_cache_key    "$scheme$host$cookie_user$request_uri";
    proxy_cache_valid  200 30s;
}
```

```bash
$ curl -si -H 'Cookie: user=alice' http://127.0.0.1:18099/user
X-Cache-Status: MISS
origin served request #5 path=/user

$ curl -si -H 'Cookie: user=bob' http://127.0.0.1:18099/user
X-Cache-Status: MISS
origin served request #6 path=/user

$ curl -si -H 'Cookie: user=alice' http://127.0.0.1:18099/user
X-Cache-Status: HIT
origin served request #5 path=/user
```

Alice and Bob get separate entries; Alice's second request is a HIT. This is the right pattern for per-user content — and the wrong one if you forget the cookie and cache everyone's dashboard under one key.

One more key-related trap: nginx OSS builds the key purely from `proxy_cache_key`. The `Vary` header is *not* part of the key, so a response that varies by `Accept-Encoding` or `Cookie` can be stored under one key and served to the wrong clients. If your origin sends `Vary`, either include the varying header in the key (`$http_accept_encoding`) or do not cache that response.

## Skipping the cache on purpose

Sometimes you must not serve from cache — a health check, a hit counter, a logged-in admin page. Two directives do it:

- `proxy_cache_bypass <condition>` — if the condition is non-empty and non-"0", do not serve from cache.
- `proxy_no_cache <condition>` — if true, do not store the response in the cache at all.

Together they force a pass-through, and the status becomes `BYPASS`. The lab uses them on `/count` (otherwise the counter would cache itself and never move again) and on a demo `/bypass` endpoint:

```nginx
location = /count {
    proxy_pass         http://origin_srv;
    proxy_cache        my_cache;
    proxy_cache_bypass 1;
    proxy_no_cache     1;
}
```

```bash
$ curl -si http://127.0.0.1:18099/bypass
X-Cache-Status: BYPASS
origin served request #8 path=/bypass

$ curl -si http://127.0.0.1:18099/bypass
X-Cache-Status: BYPASS
origin served request #9 path=/bypass

$ curl -s http://127.0.0.1:18099/count
origin has served 10 request(s)
```

Both bypass requests hit the origin; the cache directory never grew. In production the condition is usually a cookie or header — `proxy_cache_bypass $cookie_nocache;` is the classic "skip the cache when I say so" switch.

## Stale, but honest: proxy_cache_use_stale

When an entry expires, nginx normally re-fetches. But if the upstream is down, `proxy_cache_use_stale` lets nginx keep serving the expired entry instead of erroring out:

```nginx
proxy_cache_use_stale error timeout http_502 http_503 http_504;
```

I stopped the origin container and waited for the 10-second validity to lapse:

```bash
$ docker stop origin
$ sleep 12
$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: STALE
origin served request #7 path=/api?x=1

$ curl -si http://127.0.0.1:18099/api
X-Cache-Status: STALE
origin served request #1 path=/api
```

The origin is gone, and nginx still answers 200 with the last-known-good bytes. For a blog or an API with mostly-static reads, that is a genuinely nice failure mode. Add `updating` to the list plus `proxy_cache_background_update on;` and you get the stale-while-revalidate-ish pattern: clients get the stale entry instantly while one request refreshes it in the background.

## Purging: the honest gap

Here is the thing nobody tells you: **nginx OSS has no built-in cache purge.** There is no `proxy_cache_purge` directive. Your options:

- **Delete the files.** Cache entries are plain files under `proxy_cache_path`; `rm` the right one (find it by `grep`ing the key inside the files, or just clear the zone). Crude but effective — and only safe when no request is mid-write.
- **The cache manager.** nginx already evicts stale entries and, past `inactive`, idle ones. For many sites that is "purge enough."
- **njs or the third-party `ngx_cache_purge` module.** Real purge support, at the cost of a script or a module.
- **Short validity plus stale.** Accept that entries live for `proxy_cache_valid` and let `proxy_cache_use_stale` bridge the gap.

I have used the file-delete trick in an emergency more than once; I have also learned to design keys so a bad entry expires on its own.

## The risks I actually worry about

Caching an upstream is easy; caching it *safely* is where the craft is. The failure modes I have seen (or narrowly avoided):

- **Caching per-user data under a shared key.** One user's dashboard served to another. If content varies by cookie or auth, the key must include it — or the location must bypass.
- **Caching what you should not.** Anything behind login, anything with `Set-Cookie`, anything with `Cache-Control: private` (nginx will not cache those by default — which is also why the gotcha above bit me).
- **Cache poisoning via the key.** Query strings and cookies are in the key, so a client can mint unlimited unique keys (`?x=1`, `?x=2`, …) and fill your disk. Keep an eye on cache size, and do not cache endpoints with unbounded query spaces.
- **A key that is too narrow.** Drop `$host` and `www` vs apex serve the same entry; drop the query string on an API that needs it. The key is a contract — write it down.
- **Zone too small.** `keys_zone` is fixed at startup; a 10 MB zone holds ~80k keys. Size it for your real key count, or entries get evicted before their validity ends.

None of these are reasons to skip `proxy_cache` — they are reasons to pair it with `X-Cache-Status` in your logs and a `proxy_cache_key` you can explain in one sentence.

## Wrap up

`proxy_cache` is thirty lines of config and one header away from real relief for a struggling upstream: a `proxy_cache_path` with a `keys_zone`, `proxy_cache` plus `proxy_cache_valid` on the location, `add_header X-Cache-Status $upstream_cache_status always`, and a `log_format` that records the decision. Watch the header, respect the key, bypass on purpose, and let `proxy_cache_use_stale` carry you through an origin outage. And when you need to purge — plan for it, because nginx OSS will not do it for you.
