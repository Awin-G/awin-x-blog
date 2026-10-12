---
title: "Caddy vs nginx as a reverse proxy: which do I actually reach for?"
description: "A hands-on Caddy vs nginx comparison for reverse proxy work: the same job written in both, real curl -I output, HTTP/3 and compression, TLS certificate handling (automatic HTTPS vs certbot), config-size and ergonomics, and a decision list."
pubDate: 2026-12-11
lang: en
translationKey: caddy-vs-nginx
tags: [nginx, devops, networking]
featured: false
keywords:
  - Caddy vs nginx
  - Caddy reverse proxy
  - nginx reverse proxy
  - automatic HTTPS
  - ACME
---

Every few months someone asks whether they should drop **nginx** for **Caddy**, and the answers online are usually tribal. I run both. nginx is the incumbent I have configured for a decade; Caddy is the newcomer I reach for when the job is "one service, one certificate, no ceremony". To make the **Caddy vs nginx** question concrete, I put the *exact same* reverse-proxy job behind each — a tiny origin app, both proxies in front, both configs from scratch — and kept every real response. I compared an **nginx reverse proxy** and a **Caddy reverse proxy** serving identical traffic, and let **automatic HTTPS** do its thing on one side while I wired certificates by hand on the other. Nothing below is a benchmark I invented; it is `curl` output from throwaway containers on `localhost`.

If you want the deeper nginx mechanics, I keep them in the [nginx config cookbook](/posts/nginx-cookbook/); the caching headers these proxies emit are the subject of [HTTP caching explained](/posts/http-caching/).

## Caddy vs nginx: incumbent vs ergonomic newcomer

nginx is the default. It is in every distro, every Kubernetes ingress controller, every tutorial, and every colleague's memory. That is not a small thing — it means the person debugging your proxy at 2 a.m. probably already knows it. Caddy's bet is different: it assumes the hard part is not throughput but *configuration and certificates*. It ships with **automatic HTTPS** (ACME built in, on by default), HTTP/3, sane security defaults, and a config language that fits a one-service deployment on a napkin.

So the real question is not "which is faster" — for one app behind a proxy, both are vastly faster than your app needs. It is "which failure mode do I want to own": TLS renewal and module drift, or a smaller ecosystem.

## The same job as an nginx reverse proxy

The task: terminate TLS for `localhost`, proxy everything to `app:5678`, forward the client IP, compress responses. Here is the nginx side, running as `nginx/1.27.5`:

```bash
$ docker run -d --name ngx --network rpnet \
    -p 127.0.0.1:18080:80 \
    -v "$PWD/nginx.conf":/etc/nginx/conf.d/default.conf:ro \
    nginx:1.27-alpine
$ docker exec ngx nginx -v
nginx version: nginx/1.27.5
```

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://app:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
```

That is 13 lines and 344 bytes for the HTTP version. Note how much of it is *you* telling the proxy things it could reasonably assume: which headers to forward, which HTTP version to speak upstream. Nothing here is wrong — but every line is a decision you own, and forgetting `X-Forwarded-For` silently breaks rate limiting and logging downstream.

## The same job as a Caddy reverse proxy

The Caddyfile, running as `caddy:2-alpine`, expresses the same intent:

```bash
$ docker run -d --name cdy --network rpnet \
    -p 127.0.0.1:18443:443 -p 127.0.0.1:18480:80 \
    -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro \
    caddy:2-alpine
$ docker exec cdy caddy version
v2.11.7 h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUTI=
```

```caddyfile
{
	admin 127.0.0.1:2019
}

https://localhost {
	tls internal
	encode gzip zstd
	reverse_proxy app:5678 {
		header_up X-Real-IP {remote_host}
	}
}
```

Eleven lines, 146 bytes — and the *actual reverse-proxy job* is one line. Caddy infers the scheme from `https://`, turns on compression, sets the standard forwarding headers, and serves HTTP/3 on the same listener. The `tls internal` line is the only reason this is not, on a public domain, a free Let's Encrypt certificate fetched automatically. The `admin` block only exists so I can poke the JSON API later.

## Real responses: what each proxy sends back

Here is what a client actually sees. nginx on plain HTTP first:

```console
$ curl -sS -I http://127.0.0.1:18080/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 09:09:01 GMT
Content-Type: application/json
Content-Length: 186
Connection: keep-alive
```

And Caddy over its internally-issued TLS, same backend:

```console
$ curl -sS -k -I https://localhost:18443/
HTTP/2 200
alt-svc: h3=":443"; ma=2592000
content-type: application/json
date: Mon, 12 Oct 2026 09:09:01 GMT
server: BaseHTTP/0.6 Python/3.12.14
via: 1.0 Caddy
content-length: 186
```

Two things jump out. Caddy answered over **HTTP/2** and advertised **HTTP/3** with `alt-svc: h3=":443"` — out of the box, no config. nginx on plain HTTP answered HTTP/1.1, because `http2` is opt-in: adding `http2 on;` to the server block gets you `HTTP/2 200`, but only after you know to add it. HTTP/3 on nginx needs a QUIC-capable build plus a separate `listen ... quic reuseport;` UDP block; Caddy ships it.

HTTP/3 is not marketing here. Asking curl for it directly returns HTTP/3, not a fallback:

```console
$ curl -sS --http3-only -k -o /dev/null \
    -w 'http_version=%{http_version} code=%{response_code}\n' \
    https://localhost:18443/
http_version=3 code=200
```

Compression behaves the same way — one directive, real bytes:

```console
$ curl -sS -k -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    'https://localhost:18443/big'
HTTP/2 200
content-encoding: gzip
vary: Accept-Encoding
content-length: 173
```

The origin also confirms which forwarded headers each proxy adds. nginx (configured by me):

```console
$ curl -sS http://127.0.0.1:18080/demo
{
  "host": "127.0.0.1",
  "x_forwarded_for": "172.24.0.1",
  "x_forwarded_proto": "http",
  "x_real_ip": "172.24.0.1"
}
```

Caddy (default headers plus my one `header_up`):

```console
$ curl -sS -k https://localhost:18443/demo
{
  "host": "localhost:18443",
  "x_forwarded_for": "172.24.0.1",
  "x_forwarded_proto": "https",
  "x_real_ip": "172.24.0.1"
}
```

Both sets are correct. The difference is that nginx's is correct because I listed it, and Caddy's is correct because that is the default.

## TLS certificate handling: automatic HTTPS vs certbot

This is the clearest divergence. Caddy issued its own certificate on first start, with no command run, and told me where it lives:

```console
$ docker exec cdy find /data/caddy/certificates -type f
/data/caddy/certificates/local/localhost/localhost.crt
/data/caddy/certificates/local/localhost/localhost.key
/data/caddy/certificates/local/localhost/localhost.json
$ echo | openssl s_client -connect 127.0.0.1:18443 \
    -servername localhost 2>/dev/null | openssl x509 -noout -issuer
issuer=CN=Caddy Local Authority - ECC Intermediate
```

On a public domain that `tls internal` line is the *only* thing that changes: Caddy speaks **ACME** to Let's Encrypt, completes the challenge, stores and renews the certificate, and redirects HTTP to HTTPS — which it already does for the internal case:

```console
$ curl -sS -I http://127.0.0.1:18480/
HTTP/1.1 308 Permanent Redirect
Location: https://127.0.0.1/
Server: Caddy
```

nginx does none of this itself. To serve TLS it needs explicit key material and a couple more directives, and on the outside it needs an ACME client (certbot, acme.sh, lego) plus a renewal timer. I fed nginx the certificate Caddy had just generated, which is a fair stand-in for "cert files on disk":

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name localhost;

    ssl_certificate     /etc/nginx/certs/localhost.crt;
    ssl_certificate_key /etc/nginx/certs/localhost.key;

    location / {
        proxy_pass http://app:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```console
$ curl -sS -k -I https://localhost:18444/
HTTP/2 200
server: nginx/1.27.5
content-type: application/json
content-length: 186
```

Sixteen lines now, and still no certificate issuance, renewal, or HTTP→HTTPS redirect — those live in your certbot deploy hooks and your calendar. That is not a knock; it is a deliberate separation of concerns. It is also real operational surface: the number of ways a hand-wired renewal fails quietly is the reason I wrote about [automated TLS at scale](/posts/automated-tls-at-scale/).

## Config-language ergonomics: Caddy vs nginx

nginx's language is a directive tree with scopes and inheritance rules you have to hold in your head — the `add_header` inheritance trap in my [nginx cookbook](/posts/nginx-cookbook/) is a good example of a rule that bites even experienced users. It is expressive and fast, but it is a language to learn.

Caddy's is closer to a sentence: `reverse_proxy app:5678` does what it says. When you need to see what it compiles to, the JSON is right there, and you can read it:

```console
$ docker exec cdy wget -qO- http://127.0.0.1:2019/config/ | head -c 200
{"admin":{"listen":"127.0.0.1:2019"},"apps":{"http":{"servers":{"srv0":{
"listen":[":443"],"routes":[{"handle":[{"handler":"subroute",...
```

That same JSON is a live **API**: `caddy reload` swapped config with no restart, and `caddy validate` / `nginx -t` both give you a pre-flight check.

```console
$ docker exec ngxh2 nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
$ docker exec cdy caddy validate --config /etc/caddy/Caddyfile | tail -1
Valid configuration
```

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="Bar chart comparing the number of config lines needed to express the same reverse-proxy job: nginx over plain HTTP is 13 lines, nginx with explicit TLS certificates is 16 lines, and Caddy with TLS and reverse proxy is 11 lines, of which the reverse proxy itself is a single line.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="16" y="26">Same job, three configs (lines)</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <g fill="currentColor" opacity="0.9">
      <text x="16" y="66">nginx · HTTP</text>
      <text x="16" y="108">nginx · HTTPS</text>
      <text x="16" y="150">Caddy · HTTPS</text>
    </g>
  </g>
  <g fill="currentColor" opacity="0.28">
    <rect x="150" y="52" width="190" height="18" rx="4"/>
    <rect x="150" y="94" width="234" height="18" rx="4"/>
    <rect x="150" y="136" width="161" height="18" rx="4"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.9">
    <rect x="150" y="52" width="122" height="18" rx="4"/>
    <rect x="150" y="94" width="150" height="18" rx="4"/>
    <rect x="150" y="136" width="103" height="18" rx="4"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12">
    <text x="282" y="66">13 lines / 344 B</text>
    <text x="310" y="108">16 lines</text>
    <text x="263" y="150">11 lines / 146 B</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">
    <text x="150" y="176">solid bar = whole file · light bar = for scale</text>
    <text x="150" y="196">Caddy's reverse_proxy itself is one line; nginx spends five on headers alone.</text>
  </g>
</svg>
<figcaption>Config size for the identical reverse-proxy task, counted from the files above (<code>wc -c -l</code>). Line count is not quality — it is the amount of surface you own and can get wrong.</figcaption>
</figure>

## Where Caddy wins

- **Automatic HTTPS.** ACME issuance, renewal, and HTTP→HTTPS redirects are defaults, not add-ons. The 90-day-renewal-never-fires class of outage mostly disappears.
- **Tiny, readable config.** One line for the common case; the abstraction usually matches your intent on the first try.
- **Modern defaults.** HTTP/3 with `alt-svc` advertised, HTTP/2, gzip/zstd, and sensible security headers without a checklist.
- **A real JSON API.** Live config reload, programmatic configuration, and machine-readable state — genuinely nice when something else manages the proxy.
- **One binary.** No module set to reconcile with your distro's build.

## Where nginx wins

- **Ubiquity.** It is everywhere, so the help is everywhere, including the person next to you and every Stack Overflow answer from the last decade.
- **Raw performance and tuning.** nginx's worker/event model, buffering, caching, and upstream controls are deeper and more studied. If you are pushing serious load through one box, that depth is the product.
- **Modules and ecosystem.** Stream (TCP/UDP) proxying, Lua, njs, third-party modules, and the ingress controllers built on top of it.
- **Maturity.** Two decades of edge cases already debugged. Caddy is stable but younger, and its ecosystem is smaller.
- **Predictability at scale.** Teams already standardized on nginx; introducing a second proxy has a cost.

## Which do I actually reach for? A decision list

- **One box, a few services, you want TLS to just work?** Caddy. This is the case it was built for.
- **You need automatic certificates across many names without external tooling?** Caddy; it is less wiring than certbot plus deploy hooks.
- **You want HTTP/3 today with no extra build steps?** Caddy.
- **You need Lua/njs, stream proxying, or a specific module?** nginx.
- **You are tuning for the last few percent of throughput, or under very high concurrency?** nginx.
- **Your team, runbooks, and monitoring all assume nginx?** Stay on nginx. Consistency beats elegance.
- **You are already happy with certbot and a renewal timer?** There is no reason to migrate. "Caddy is nicer" is not, by itself, a reason to rewrite a working config.
- **Learning one of them for the first time?** Learn nginx, because you will meet it; learn Caddy, because it teaches you what good defaults look like.

That is the honest answer: I still reach for nginx when I need its depth or the team already speaks it, and for everything new and small, I reach for Caddy and let **automatic HTTPS** do the part I used to automate by hand.
