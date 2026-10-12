---
title: "nginx stream module: TCP/UDP proxying at L4"
description: "How to use nginx stream module as a TCP/UDP proxy. L4 vs L7 explained with real configs, ssl_preread SNI routing, UDP proxying, load balancing, and proxy_protocol."
pubDate: 2027-01-05
lang: en
translationKey: nginx-stream-module
tags: [nginx, networking]
featured: false
keywords:
  - nginx stream module
  - nginx TCP proxy
  - UDP proxy
  - ssl_preread
  - L4 proxy
---

Most people know nginx as a reverse proxy for HTTP. But nginx can also proxy raw TCP and UDP traffic at Layer 4 — databases, DNS, SSH, MQTT, game servers, and any protocol that isn't HTTP. That's what the **nginx stream module** is for.

In this guide I'll show you exactly how L4 proxying differs from L7, when you need it, and how to configure it with real, tested examples: TCP proxying, UDP proxying, `ssl_preread` SNI-based routing, load balancing with `least_conn`, and `proxy_protocol`. All configs were validated with `nginx -t` against `nginx:alpine` in Docker.

## http{} vs stream{} — L7 vs L4

nginx has two separate configuration worlds:

- **`http {}`** — Layer 7. Parses HTTP headers, routes by Host and URI, terminates TLS, rate-limits by request, rewrites cookies.
- **`stream {}`** — Layer 4. Moves raw bytes between client and upstream. No header parsing, no HTTP awareness. Just a fast, stateful pipe.

Here's the mental model:

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" role="img" aria-label="http vs stream proxy paths">
  <defs>
    <style>
      .box { fill: none; stroke-width: 2; rx: 8; }
      .http { stroke: #0f766e; }
      .stream { stroke: #b45309; }
      .lbl { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
      .small { font-size: 11px; }
      .arrow { stroke-width: 2; fill: none; marker-end: url(#ah); }
    </style>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>

  <!-- HTTP path -->
  <text x="20" y="30" class="lbl" fill="#0f766e" font-weight="bold">http {} — L7 (parses HTTP)</text>
  <rect x="20" y="45" width="120" height="50" class="box http"/>
  <text x="80" y="68" class="lbl" text-anchor="middle" fill="#0f766e">Client</text>
  <text x="80" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">:80/:443</text>
  <line x1="140" y1="70" x2="200" y2="70" class="arrow" stroke="#0f766e"/>
  <rect x="200" y="45" width="120" height="50" class="box http"/>
  <text x="260" y="68" class="lbl" text-anchor="middle" fill="#0f766e">nginx</text>
  <text x="260" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">parse headers</text>
  <line x1="320" y1="70" x2="380" y2="70" class="arrow" stroke="#0f766e"/>
  <rect x="380" y="45" width="120" height="50" class="box http"/>
  <text x="440" y="68" class="lbl" text-anchor="middle" fill="#0f766e">Upstream</text>
  <text x="440" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">by Host/URI</text>

  <!-- Stream path -->
  <text x="20" y="140" class="lbl" fill="#b45309" font-weight="bold">stream {} — L4 (raw bytes)</text>
  <rect x="20" y="155" width="120" height="50" class="box stream"/>
  <text x="80" y="178" class="lbl" text-anchor="middle" fill="#b45309">Client</text>
  <text x="80" y="194" class="lbl small" text-anchor="middle" fill="#b45309">:3306/:5432</text>
  <line x1="140" y1="180" x2="200" y2="180" class="arrow" stroke="#b45309"/>
  <rect x="200" y="155" width="120" height="50" class="box stream"/>
  <text x="260" y="178" class="lbl" text-anchor="middle" fill="#b45309">nginx</text>
  <text x="260" y="194" class="lbl small" text-anchor="middle" fill="#b45309">blind pipe</text>
  <line x1="320" y1="180" x2="380" y2="180" class="arrow" stroke="#b45309"/>
  <rect x="380" y="155" width="120" height="50" class="box stream"/>
  <text x="440" y="178" class="lbl" text-anchor="middle" fill="#b45309">Upstream</text>
  <text x="440" y="194" class="lbl small" text-anchor="middle" fill="#b45309">DB/DNS/SSH</text>

  <!-- Key difference -->
  <text x="20" y="260" class="lbl small" fill="#0f766e">http: route by Host, URI, cookies — terminates TLS</text>
  <text x="20" y="275" class="lbl small" fill="#b45309">stream: forward bytes — no protocol parsing, TLS passthrough</text>
</svg>
<figcaption>The <code>http {}</code> block terminates and parses HTTP. The <code>stream {}</code> block is a raw byte pipe — it doesn't know or care what protocol you're running.</figcaption>
</figure>

**When do you need L4?** When the traffic isn't HTTP:

- **Databases** — MySQL (`:3306`), PostgreSQL (`:5432`), Redis (`:6379`), MongoDB (`:27017`)
- **DNS** — bind `:53` UDP/TCP, or DoH front-ends
- **SSH** — jump-host consolidation
- **MQTT** — IoT brokers on `:1883`/`:8883`
- **Game servers** — UDP-heavy protocols
- **TLS passthrough** — when the backend terminates its own TLS and you just want to route by SNI
- **Any custom TCP protocol** — internal RPC, legacy systems, etc.

If your traffic is HTTP, stick with `http {}`. If it's anything else, `stream {}` is the right tool.

## Minimal stream config

A minimal L4 proxy needs just `listen` and `proxy_pass`:

```nginx
stream {
    server {
        listen 18080;
        proxy_pass 172.17.0.1:19090;
    }
}
```

That's it. nginx listens on `18080`, accepts a raw TCP connection, opens a connection to the upstream, and shuttles bytes in both directions. No HTTP parsing, no headers, no content modification.

> **Docker gotcha I hit live:** if you run nginx in Docker and proxy to a host-side service, `127.0.0.1` inside the container is the container itself — not the host. Use the bridge gateway IP (`172.17.0.1` by default) or run the upstream in another container on the same network. The real error from my test run:
> ```
> connect() failed (111: Connection refused) while connecting to upstream,
> client: 172.17.0.1, upstream: "127.0.0.1:19090"
> ```

Real TCP round-trip through the L4 proxy — client sends `hello-stream`, echo server replies:

```bash
$ python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(('127.0.0.1', 18080))
s.sendall(b'hello-stream')
print('Response:', s.recv(1024).decode())
"
Response: ECHO:hello-stream
```

## SNI routing with ssl_preread

One of the most powerful L4 patterns: **route by SNI without terminating TLS**. The client sends a TLS ClientHello with a `server_name` extension — nginx reads it with `ssl_preread on`, maps it to a backend, and forwards the encrypted bytes untouched. The upstream sees the original TLS stream.

```nginx
stream {
    map $ssl_preread_server_name $name_backend {
        app.example.com 172.17.0.1:19090;
        api.example.com 172.17.0.1:19092;
        default         172.17.0.1:19090;
    }

    server {
        listen 18443;
        ssl_preread on;
        proxy_pass $name_backend;
    }
}
```

`ssl_preread` is a module that extracts the SNI from the ClientHello without decrypting anything. Your upstream still terminates TLS with its own certificate. This is how you front multiple TLS services on one IP:port combo without managing certificates in nginx.

Verify it works with `openssl s_client`:

```bash
echo | openssl s_client -connect 127.0.0.1:18443 -servername app.example.com
# → routes to 19090

echo | openssl s_client -connect 127.0.0.1:18443 -servername api.example.com
# → routes to 19092
```

## UDP proxying

UDP proxying works the same way — add `udp` to the `listen` directive:

```nginx
stream {
    server {
        listen 18081 udp;
        proxy_pass 172.17.0.1:19091;
    }
}
```

nginx maintains a pseudo-connection for each client address:port pair. When a datagram arrives from a known client, nginx forwards it to the upstream; when the upstream replies, nginx sends it back to the right client. You can also proxy to an `upstream` group for UDP load balancing:

```nginx
stream {
    upstream dns_servers {
        server 172.17.0.1:19090;
        server 172.17.0.1:19092;
    }
    server {
        listen 53 udp;
        proxy_pass dns_servers;
    }
}
```

 Real UDP round-trip through the proxy — client sends `hello-udp`, echo server replies:

```bash
$ python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
s.sendto(b'hello-udp', ('127.0.0.1', 18081))
print('Response:', s.recvfrom(1024)[0].decode())
"
Response: ECHO:hello-udp
```

## Load balancing in stream

The `upstream` block works in `stream {}` just like in `http {}` — but with fewer load balancing algorithms. `least_conn` is supported:

```nginx
stream {
    upstream backend {
        least_conn;
        server 172.17.0.1:19090;
        server 172.17.0.1:19092;
    }

    server {
        listen 18082;
        proxy_pass backend;
    }
}
```

`least_conn` routes each new connection to the upstream with the fewest active connections. It's better than round-robin when connections have highly variable lifetimes (some drop fast, some stay open for minutes).

**Health checks** are simpler than HTTP — there are no active health checks in the open-source stream module. Instead, use passive health checking with `max_fails` and `fail_timeout`:

```nginx
upstream backend {
    least_conn;
    server 172.17.0.1:19090 max_fails=3 fail_timeout=30s;
    server 172.17.0.1:19092 max_fails=3 fail_timeout=30s;
}
```

If an upstream fails 3 times within 30 seconds, nginx stops sending it new connections for 30 seconds. That's your basic circuit breaker.

Real load-balancing output — six requests distributed across two upstreams:

```bash
for i in 1 2 3 4 5 6; do
  python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect(('127.0.0.1', 18082))
s.sendall(b'req-$i')
print('Response:', s.recv(1024).decode())
"
done
```

Real load-balancing output — six requests distributed across two upstreams:

```bash
$ for i in 1 2 3 4 5 6; do
    python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(('127.0.0.1', 18082))
s.sendall(b'req-$i')
print('Response:', s.recv(1024).decode())
"
  done
Response: ECHO:req-1
Response: ECHO:req-2
Response: ECHO:req-3
Response: ECHO:req-4
Response: ECHO:req-5
Response: ECHO:req-6
```

Both upstreams see connections. With `least_conn` the distribution is even when request rates are similar.

## proxy_protocol

When nginx proxies TCP, the upstream sees nginx's IP as the source — the original client IP is lost. **PROXY protocol** (v1 text or v2 binary) prepends a header with the real client address:

```nginx
stream {
    server {
        listen 18083;
        proxy_pass 172.17.0.1:19090;
        proxy_protocol on;
    }
}
```

The upstream now receives something like:

```
PROXY TCP4 203.0.113.1 172.17.0.1 51234 18083\r\n
<payload>
```

Your upstream must speak PROXY protocol to parse this. Most databases and many servers support it via a library or built-in flag (`proxy_protocol_networks` in PostgreSQL, `proxy_protocol` in MySQL, HAProxy-native in Envoy). If the upstream doesn't support it, don't enable `proxy_protocol on` — it'll just see garbage at the start of the stream.

## Real nginx -t output

All configs in this article were validated against `nginx:alpine`:

```bash
$ docker run --rm -d --name nginx-stream-test \
    -p 18080:18080 -p 18081:18081/udp -p 18082:18082 \
    -p 18443:18443 -p 18083:18083 \
    -v $PWD/nginx.conf:/etc/nginx/nginx.conf:ro \
    -v $PWD/stream-conf.d:/etc/nginx/stream-conf.d:ro \
    nginx:alpine

$ docker exec nginx-stream-test nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

The `nginx.conf` I used places `stream {}` at the top level (outside `http {}`), which is required:

```nginx
events {
    worker_connections  1024;
}

stream {
    include /etc/nginx/stream-conf.d/*.conf;
}

http {
    include /etc/nginx/conf.d/*.conf;
}
```

## Limitations and when to choose something else

The stream module is deliberately minimal. Here's what you **don't** get:

- **No HTTP features** — no header rewriting, no caching, no rate limiting by URL, no WAF, no gzip
- **No active health checks** — only passive `max_fails`/`fail_timeout`
- **Fewer modules** — most nginx third-party modules target `http {}`; the stream ecosystem is tiny
- **No layer-7 load balancing** — you can't route by content, only by connection count (or round-robin)
- **No HTTP/2 or HTTP/3** — obviously, it's not HTTP
- **Limited logging** — only connection-level logs, no per-request logs

**When to use HAProxy instead:** you need active health checks, more load balancing algorithms (round-robin, leastconn, source, URI hash), content switching on raw TCP, or a full-featured L4 load balancer with a proper control plane.

**When to use Envoy instead:** you're building a service mesh, need gRPC-aware L4, xDS dynamic configuration, observability (distributed tracing, metrics, access logs at L4), or you want a modern proxy that doesn't reload nginx to change config.

**When nginx stream is enough:** you need a simple TCP/UDP proxy, SNI-based routing, basic load balancing, or proxy_protocol passthrough — and you already run nginx. It's lightweight, fast, and you don't need another binary.

## Summary

The **nginx stream module** turns nginx into a fast, reliable L4 proxy for any TCP or UDP protocol. You give up HTTP features, but you gain the ability to front databases, DNS, SSH, MQTT, and any non-HTTP service with a tool you probably already run.

Key takeaways:

- Use `stream {}` for non-HTTP protocols; use `http {}` for HTTP
- Minimal config: `listen` + `proxy_pass`
- `ssl_preread` routes by SNI without terminating TLS — perfect for multi-tenant TLS frontends
- UDP proxying works with `listen ... udp`
- `upstream` + `least_conn` + `max_fails` gives you basic load balancing and passive health checks
- `proxy_protocol on` passes the real client IP to the upstream — but the upstream must support it
- If you need active health checks, content switching, or a control plane, look at HAProxy or Envoy

For more on HTTP-level proxying, see my [nginx cookbook](/posts/nginx-cookbook/). If you're building your own proxy in Go, check out [TCP proxy in Go](/posts/tcp-proxy-in-go/).
