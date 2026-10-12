---
title: "Getting the real client IP through a proxy: nginx real_ip, X-Forwarded-For, and proxy_protocol"
description: "Behind a CDN, LB, or reverse proxy, $remote_addr is the proxy, not your user. How X-Forwarded-For, X-Real-IP, and Forwarded work, how nginx real_ip rewrites the client IP with set_real_ip_from and real_ip_recursive, why proxy_protocol is harder to spoof, and the trap of trusting a header you did not write."
pubDate: 2026-12-21
lang: en
translationKey: real-client-ip
tags: [networking, nginx]
featured: false
keywords:
  - X-Forwarded-For
  - real client IP
  - nginx real_ip
  - proxy_protocol
  - trusted proxy
---

The day you put a CDN or a load balancer in front of your app, every log line starts reading the same address. `$remote_addr` becomes your own proxy, your per-IP rate limiter sees one client, and the audit trail you carefully built is now useless. The fix is not a single config knob — it is deciding which hops you actually trust to tell you the truth about the **real client IP**. In this post I wire up a client → CDN → nginx → app chain in throwaway containers, capture what each layer really sees, show how **nginx real_ip** and **proxy_protocol** recover the originating address, and then show how a single careless directive lets an attacker forge that address with a hand-typed header.

If you want the nginx basics first, see my [nginx config cookbook](/posts/nginx-cookbook/); for the container plumbing, the [Docker networking post](/posts/docker-networking/) covers how these container IPs come about.

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="A request flowing from a client through a CDN, a load balancer, nginx, and an app. Each TCP hop only sees the previous hop's address, so nginx must rewrite $remote_addr from X-Forwarded-For or the PROXY protocol.">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="16" y="76" width="112" height="52" rx="6"/>
    <rect x="160" y="76" width="112" height="52" rx="6"/>
    <rect x="304" y="76" width="112" height="52" rx="6"/>
    <rect x="448" y="76" width="112" height="52" rx="6" stroke="#0f766e" stroke-width="2.5"/>
    <rect x="592" y="76" width="112" height="52" rx="6"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="72" y="107">Client</text>
    <text x="216" y="107">CDN</text>
    <text x="360" y="107">LB</text>
    <text x="504" y="107" fill="#0f766e">nginx</text>
    <text x="648" y="107">App</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
    <line x1="130" y1="102" x2="156" y2="102"/>
    <line x1="274" y1="102" x2="300" y2="102"/>
    <line x1="418" y1="102" x2="444" y2="102"/>
    <line x1="562" y1="102" x2="588" y2="102"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.85">
    <text x="143" y="150">sees client</text>
    <text x="287" y="150">sees CDN</text>
    <text x="431" y="150">sees LB</text>
    <text x="575" y="150">sees nginx</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, Menlo, monospace" font-size="10.5" text-anchor="middle" opacity="0.7">
    <text x="143" y="60">XFF: -</text>
    <text x="287" y="60">XFF: client</text>
    <text x="431" y="60">XFF: client, cdn</text>
    <text x="575" y="60">XFF: client, cdn, lb</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" text-anchor="middle">
    <text x="504" y="176">real_ip / proxy_protocol</text>
    <text x="504" y="194">rewrites $remote_addr</text>
    <text x="504" y="212">to the client — if trusted</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
    <line x1="504" y1="184" x2="504" y2="132"/>
  </g>
</svg>
<figcaption>Each TCP hop only ever sees the previous hop. nginx can recover the client from <code>X-Forwarded-For</code> or the PROXY protocol — but only when it is allowed to trust the address the header came from.</figcaption>
</figure>

## Why `$remote_addr` is the proxy's IP behind a reverse proxy

A proxy does not forward your packets; it terminates your TCP connection, reads the request, and opens a *new* connection to the next hop. Addresses are not preserved — the L3 source of every connection is just "whoever opened it". So on the app side, the peer is always the last proxy, never the human.

I reproduced this with three containers on a private bridge (`172.31.7.0/24`):

- `realip-app` — a tiny Python echo server that prints its peer and the forwarded headers (`172.31.7.10`)
- `realip-proxy` — the edge nginx (`172.31.7.11`)
- `realip-cdn` — a second nginx pretending to be the CDN (`172.31.7.12`), publishing `127.0.0.1:8080`

A `curl` from the host hits the CDN, which proxies to the edge, which proxies to the app:

```bash
$ docker network create --subnet 172.31.7.0/24 realip
$ curl -s http://127.0.0.1:8080/            # through cdn -> edge -> app
{
  "app_sees_peer": "172.31.7.11",
  "app_sees_headers": {
    "Host": "127.0.0.1",
    "X-Forwarded-For": "172.31.7.1, 172.31.7.12",
    "X-Real-IP": "172.31.7.12"
  }
}
```

The app's TCP peer is `172.31.7.11` (the edge nginx). The edge's access log is no better — it only knows the CDN:

```text
172.31.7.12 - - [12/Oct/2026:10:33:46 +0000] "GET /s1-honest HTTP/1.1" 200 171 "-" "curl/8.22.0"
```

The real client (`172.31.7.1`, the Docker gateway standing in for the internet) appears nowhere in the connection metadata. It survives only inside the `X-Forwarded-For` header string. That is the entire problem in one line: **the client IP is now application data, not connection state.** Anything you build on connection state — logs, `limit_req`, `allow`/`deny`, fail2ban — silently keys on the wrong identity.

## The three headers: X-Forwarded-For, X-Real-IP, Forwarded

There is no single standard that everyone follows, so most stacks see all three:

- **`X-Forwarded-For`** — a comma-separated list. Each proxy *appends* the address it saw: `client, proxy1, proxy2`. The leftmost entry is claimed to be the original client; every later entry is a hop. Because each hop appends to whatever it received, list length equals the number of hops that bothered to set it.
- **`X-Real-IP`** — a single address, set by the nearest proxy. Simple, and the one nginx emits by default in many recipes (`proxy_set_header X-Real-IP $remote_addr`).
- **`Forwarded`** — the RFC 7239 header, carrying `for=`, `by=`, `proto=`, `host=` with optional quoting and IPv6 brackets. Correct but less widely emitted; nginx has no built-in `$forwarded` variable.

In the capture above the app received `X-Forwarded-For: 172.31.7.1, 172.31.7.12`: the CDN appended the client it saw, and the edge appended the CDN. Note the count: **two entries for two proxies**, which is only true because each guarded hop appended. A header that arrives with one entry when it should have two is your first hint that a hop stripped or forged it.

## nginx real_ip: set_real_ip_from, real_ip_header, real_ip_recursive

The `ngx_http_realip_module` is built into the official nginx image. It replaces `$remote_addr` (and `$remote_port`) with an address taken from a header — but *only for connections from proxies you explicitly name*:

```nginx
server {
    listen 80;

    # Trust the CDN and nobody else.
    set_real_ip_from 172.31.7.12;
    real_ip_header    X-Forwarded-For;
    real_ip_recursive on;

    location / {
        proxy_pass http://172.31.7.10:9000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP       $remote_addr;
    }
}
```

- **`set_real_ip_from`** — the trusted source. Accepts an address or CIDR; repeat it per network. The module ignores the header for any connection whose peer is not in this set, so a stranger cannot inject an address from a non-trusted connection.
- **`real_ip_header`** — which header to read (`X-Forwarded-For`, `X-Real-IP`, `proxy_protocol`, or `Forwarded`).
- **`real_ip_recursive`** — with `on`, nginx walks the `X-Forwarded-For` list from right to left, discarding addresses that are themselves in a `set_real_ip_from` range, and stops at the first address that is *not* trusted. With `off` (the default), it just takes the **last** entry.

The `$realip_remote_addr` variable holds the original peer, which is how you debug whether the module fired:

```text
remote_addr=172.31.7.1  realip_remote=172.31.7.12  xff="172.31.7.1"            req="GET /s2-honest HTTP/1.1"
remote_addr=172.31.7.1  realip_remote=172.31.7.12  xff="203.0.113.7, 172.31.7.1" req="GET /s2-spoof HTTP/1.1"
```

Compare that to the same edge with the module unset, where `$remote_addr` is stuck on the CDN:

```text
172.31.7.12 - - "GET /s1-honest HTTP/1.1" 200
172.31.7.12 - - "GET /s1-spoof  HTTP/1.1" 200
```

Now the client address is correct — and notice the second line. A hostile client sent `X-Forwarded-For: 203.0.113.7`, the CDN dutifully appended its peer, and the list became `203.0.113.7, 172.31.7.1`. Because only the CDN is trusted, recursive mode skipped the trusted `172.31.7.12`, stopped at the untrusted-but-real `172.31.7.1`, and **the forged leftmost entry was correctly ignored**.

## The trap: trusting X-Forwarded-For from anyone

Now break one line. Replace `set_real_ip_from 172.31.7.12;` with `set_real_ip_from 0.0.0.0/0;` — "trust every client". Same three requests, but the attacker now chooses their own identity per request:

```text
remote_addr=203.0.113.7  ... xff="203.0.113.7, 172.31.7.1"  req="GET /bypass-a HTTP/1.1"
remote_addr=198.51.100.9 ... xff="198.51.100.9, 172.31.7.1" req="GET /bypass-b HTTP/1.1"
remote_addr=10.0.0.1     ... xff="10.0.0.1, 172.31.7.1"     req="GET /bypass-c HTTP/1.1"
```

Every request is logged as a brand-new client. That is a **spoofing** primitive, and it breaks three things at once:

1. **Logs and forensics** — your only record of the attacker is now attacker-controlled.
2. **Rate limiting** — `limit_req_zone ... key=$binary_remote_addr` gives each forged identity its own bucket, so a brute-force run never trips the limit. The same trick defeats per-IP quotas and lockouts.
3. **IP allowlists** — if `allow 10.0.0.0/8;` is evaluated against a header, an external attacker just sets `X-Forwarded-For: 10.0.0.1` (as in `bypass-c`) and walks through the front door.

The flip side is equally common and shows up in short-circuiting apps: an application that reads `X-Forwarded-For` and takes the **first** value, with no awareness of trust at all. In my captures the app received `X-Forwarded-For: 203.0.113.7, 172.31.7.1, 172.31.7.1` — position 0 is the lie. The rule is blunt and absolute: **a forwarding header is a claim. It is only evidence if it came from a hop you trust, and every hop in front of you must have appended to it.** If any hop in the chain passes the client's header through untouched, the leftmost value is attacker-controlled, full stop.

## proxy_protocol: an L4 prelude that is harder to lie about

Header-based forwarding has a structural weakness: it is just an HTTP header, and any client can type one. The PROXY protocol closes that gap by putting the client address **before the HTTP request, at the TCP layer**. nginx reads it as the first bytes of the connection, and the header only exists because the proxy in front of it was configured to emit it.

Enable it on the listener, then teach `real_ip` to consume it:

```nginx
server {
    listen 80 proxy_protocol;      # this socket now REQUIRES a PROXY header
    set_real_ip_from 172.31.7.0/24; # the LB is the only allowed source
    real_ip_header   proxy_protocol;
    location / {
        proxy_pass http://172.31.7.10:9000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP       $remote_addr;
    }
}
```

A normal HTTP client that does not speak the protocol is simply rejected — nginx tries to parse `GET / HTTP/1.1` as a PROXY line and fails:

```text
[error] broken header: "GET /plain HTTP/1.1" while reading PROXY protocol, client: 172.31.7.1
```

A client that *does* speak it (here a five-line Python socket sending `PROXY TCP4 198.51.100.42 ...`) is accepted, and nginx rewrites the client address from the prelude:

```text
remote_addr=198.51.100.42  realip_remote=172.31.7.1  proxy_protocol_addr=198.51.100.42  req="GET / HTTP/1.1"
```

Why is this safer than a header? Because it cannot be forged by the end client in the normal setup: to send a PROXY line you must open a raw connection to the socket that expects one, and `real_ip_header proxy_protocol` only honors the address when the connection's peer is inside `set_real_ip_from`. In the capture above, `realip_remote=172.31.7.1` is the actual peer and `198.51.100.42` is the asserted client — trust is explicit per-hop. The trade-off is that `proxy_protocol` is a per-connection setting: enable it on a listener that a non-proxy client also reaches and you break that client, exactly as in the `broken header` error above. It is the right tool when *you* control the hop in front (your own LB, HAProxy, an AWS NLB, Cloudflare), and overkill when you do not.

## Your logs and rate limits hang off this decision

Everything downstream keys on the identity you resolved:

- **Access logs** — `log_format` using `$remote_addr` is wrong the moment a proxy appears. Log `$remote_addr` *and* the raw `$http_x_forwarded_for` so you can tell a real address from a forwarded one.
- **Rate limiting** — `limit_req_zone $binary_remote_addr zone=...` is only meaningful if `$remote_addr` is the client. Otherwise a spoofed or collapsed address makes the limiter either useless or unfairly brutal when hundreds of users hide behind one NAT address.
- **Allow/deny and WAF rules** — they evaluate the resolved address, so a bad `real_ip` config turns an internal-only rule into a suggestion.
- **App-layer checks** — anything reading `X-Forwarded-For` directly must apply the *same* trust policy as nginx, or you get two different notions of "client".

## A per-layer checklist: CDN → LB → nginx → app

Each hop must do its part; one weak link makes the whole chain forgeable.

- **CDN** — must *append* the client address to any inbound `X-Forwarded-For` (never replace, never blindly pass through) and expose its real edge ranges so you can trust them. Most publish a list; pin the ranges you accept updates from.
- **LB / reverse proxy** — enable `proxy_protocol` or set `X-Forwarded-For` yourself; make sure it overwrites `X-Real-IP` and does not forward the client's own values verbatim. If it speaks PROXY protocol, configure the backend listener to require it.
- **nginx** — `set_real_ip_from` only the CIDRs of the hop directly in front (not `0.0.0.0/0`), pick the header that hop actually sets, and enable `real_ip_recursive on` when there is a list. Verify with `$realip_remote_addr` in the log; if it is empty, the module never fired.
- **App** — trust forwarded headers only from the local nginx/network, take the address from the right of the list if it must parse, and never use a client-supplied header for authorization.
- **Nowhere** — never let a header decide an allowlist unless the connection that carried it is itself restricted to a trusted hop. This one rule prevents the entire class of bypasses above.

The mental model is small. Each hop sees only the previous hop; the client address is a claim carried in-band; and the only way a claim becomes evidence is if every hop that touched it is one you trust and that appended rather than echoed. Get the trust set right — narrow, per-hop, and verified in the logs — and `X-Forwarded-For`, `X-Real-IP`, `real_ip`, and `proxy_protocol` all line up. Get it wrong, and you have shipped a client IP that anyone can choose.
