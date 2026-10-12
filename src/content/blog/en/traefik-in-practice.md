---
title: "Traefik in practice: how Docker labels become your reverse proxy config"
description: "A hands-on Traefik walkthrough: how a dynamic reverse proxy differs from nginx, how providers feed routers, middlewares and services, real Traefik Docker labels routing a container, auto-discovery as containers come online, live /api output, and when plain nginx is simpler."
pubDate: 2026-12-18
lang: en
translationKey: traefik-in-practice
tags: [devops, nginx]
featured: false
keywords:
  - Traefik
  - Traefik Docker labels
  - reverse proxy
  - auto-discovery
  - middleware
---

Most reverse proxies are configured by editing a file and reloading. **Traefik** is built on the opposite premise: the proxy watches the place your services already live — Docker, Kubernetes, a service registry — and derives its routing config from what it finds. That means the most important part of a **Traefik Docker labels** deployment is not a `traefik.yml`; it is the labels on the containers you are already running. To make this concrete I wired a real **reverse proxy** by hand in a throwaway lab: two tiny services, an entrypoint on `127.0.0.1:18080`, and **auto-discovery** that picked up a brand-new container with no restart. Every block of output below is copied from a `traefik:v3.7.14` container on my machine, then torn down.

If you want the static-proxy fundamentals first, I keep them in the [nginx config cookbook](/posts/nginx-cookbook/); the automatic-HTTPS comparison lives in [Caddy vs nginx](/posts/caddy-vs-nginx/).

## Traefik is a dynamic reverse proxy, not a static config file

nginx is a *static* reverse proxy: you write `server` and `location` blocks, decide which upstream each path goes to, and reload. The config describes the world as you understand it at edit time. Traefik is a *dynamic* one. You declare **providers** (Docker, Kubernetes Ingress, Consul, a file, etc.), and Traefik keeps a live model of the world by watching those providers. Add a container with the right labels and a route appears within a second; remove it and the route disappears. There is no reload step and no config file per service.

That is the whole pitch, and it is also the whole trade-off. You trade "a file I can read top to bottom" for "a live graph assembled from many sources". Traefik's job is to make that graph legible — which is why the dashboard and the API matter so much.

## Providers, routers, middlewares, services: the vocabulary

Traefik's model is small, and everything else hangs off it:

- **Provider** — where config comes from. `docker` is the one this post uses; it reads labels off the Docker socket.
- **Entrypoint** — the port Traefik listens on (e.g. `web` on `:80`, `websecure` on `:443`).
- **Router** — a rule (`Host(api.localhost)`, `PathPrefix(/api)`) that matches a request on an entrypoint and points it at a service.
- **Middleware** — a transform applied between router and service: strip a prefix, add headers, rate-limit, basic auth, redirect.
- **Service** — where traffic actually goes: a load balancer over your containers.

<figure>
<svg viewBox="0 0 900 280" width="100%" role="img" aria-label="One request flows from clients into a Traefik entrypoint on web port 80, into a router that matches a Host rule, through a chain of middlewares (stripPrefix, headers, ratelimit), and finally to a load-balanced service backed by containers.">
  <g font-family="system-ui, sans-serif" font-size="12.5" fill="currentColor">
    <text x="14" y="24">one request, five objects</text>
  </g>

  <!-- clients -->
  <rect x="14" y="100" width="120" height="80" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="74" y="132">clients</text>
    <text x="74" y="154" font-size="11.5" opacity="0.75">curl · browser</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="134" y1="140" x2="176" y2="140"/>
    <path d="M170 135 L178 140 L170 145" fill="none"/>
  </g>

  <!-- entrypoint -->
  <rect x="176" y="90" width="150" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="#0f766e" text-anchor="middle">
    <text x="251" y="128">entrypoint</text>
    <text x="251" y="150" font-size="11.5">web :80</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="326" y1="140" x2="368" y2="140"/>
    <path d="M362 135 L370 140 L362 145" fill="none"/>
  </g>

  <!-- routers -->
  <rect x="368" y="30" width="180" height="220" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="458" y="54" text-anchor="middle">routers</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9">
    <text x="382" y="88">Host whoami.localhost</text>
    <text x="382" y="116">Host api.localhost</text>
    <text x="394" y="134" opacity="0.7">+ PathPrefix /api</text>
    <text x="382" y="162">Host limited.localhost</text>
  </g>

  <!-- dashed link -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5" stroke-dasharray="4 4">
    <line x1="548" y1="140" x2="580" y2="140"/>
  </g>

  <!-- middlewares -->
  <rect x="580" y="30" width="160" height="220" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="660" y="54" text-anchor="middle">middlewares</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9">
    <text x="594" y="88">stripPrefix /api</text>
    <text x="594" y="116">headers + ratelimit</text>
    <text x="594" y="144">basicAuth · redirect</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="740" y1="140" x2="778" y2="140"/>
    <path d="M772 135 L780 140 L772 145" fill="none"/>
  </g>

  <!-- services -->
  <rect x="778" y="70" width="112" height="140" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="834" y="102">services</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9" text-anchor="middle">
    <text x="834" y="136">whoami</text>
    <text x="834" y="160">api</text>
  </g>
</svg>
<figcaption>Traefik's request path: clients hit an <strong>entrypoint</strong>, a <strong>router</strong> matches a rule, the router's <strong>middlewares</strong> transform the request, and a <strong>service</strong> load-balances to your containers. In Docker, every one of these objects can come from a container label.</figcaption>
</figure>

## Traefik Docker labels: auto-discovery in practice

I ran this on `traefik:v3.7.14` with `traefik/whoami:v1.10.4` as the backend. One honest note up front: against Docker Engine 29, Traefik older than 3.6 fails with `client version 1.24 is too old` — the bundled Docker client doesn't negotiate the newer API. 3.7 negotiates fine, which is why the lab uses it.

### The half that is static: Traefik's own startup

Traefik itself has a small static config, given on the command line. It says "use the Docker provider, and here is the entrypoint":

```bash
$ docker network create traefik-lab
$ docker run -d --name traefik-lab --network traefik-lab \
    -p 127.0.0.1:18080:80 -p 127.0.0.1:18090:8080 \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    traefik:v3.7 \
    --providers.docker=true \
    --providers.docker.exposedbydefault=false \
    --providers.docker.network=traefik-lab \
    --entrypoints.web.address=:80 \
    --api.insecure=true
```

Two flags carry most of the weight. `--providers.docker.exposedbydefault=false` means a container is *invisible* to Traefik until it opts in with `traefik.enable=true` — without it, every container on the host becomes a route. `--providers.docker.network` pins routing to one network so Traefik knows which container IP to dial. Note that this static half does **not** mention any of my services.

### The half that is dynamic: labels on the app

The route to my first service lives entirely on the container. Nothing is registered with Traefik; the label set *is* the registration:

```bash
$ docker run -d --name whoami --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.whoami.rule=Host(`whoami.localhost`)' \
    --label traefik.http.routers.whoami.entrypoints=web \
    --label traefik.http.services.whoami.loadbalancer.server.port=80 \
    traefik/whoami:v1.10
```

Read the label keys as a path: `traefik.http.routers.<name>.<field>` defines a router called `whoami`; `traefik.http.services.<name>.<field>` defines a service. The router matches `Host(whoami.localhost)` on the `web` entrypoint and forwards to the service, whose load balancer targets port 80 of this container. Traefik discovers it from the Docker socket — no reload command, no `-H UPSTREAM` flag.

### A real request, routed by labels

Ask for that host and the request lands on the whoami container:

```bash
$ curl -s -H 'Host: whoami.localhost' http://127.0.0.1:18080/
Hostname: a57184410c76
RemoteAddr: 172.19.0.2:60162
GET / HTTP/1.1
Host: whoami.localhost
X-Forwarded-For: 172.19.0.1
X-Forwarded-Host: whoami.localhost
X-Forwarded-Port: 80
X-Forwarded-Proto: http
X-Real-Ip: 172.19.0.1
```

Those `X-Forwarded-*` headers are Traefik's default behaviour — it forwards the client IP and original host automatically. In nginx you write those four lines yourself, and forgetting `X-Forwarded-For` quietly breaks downstream logging and rate limiting.

### Auto-discovery: adding a service without touching Traefik

The payoff is what happens when a new container appears. I started a second whoami with a different host label and, three seconds later, asked the API how many routers existed:

```bash
$ docker run -d --name whoami2 --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.whoami2.rule=Host(`hello.localhost`)' \
    --label traefik.http.routers.whoami2.entrypoints=web \
    --label traefik.http.services.whoami2.loadbalancer.server.port=80 \
    traefik/whoami:v1.10

$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: hello.localhost' http://127.0.0.1:18080/
200
```

In the debug log, that container's arrival shows up as a load balancer being built on the spot:

```text
Creating load-balancer entryPointName=web routerName=whoami2@docker serviceName=whoami2@docker
```

Nothing was edited and Traefik was never restarted. This is the **auto-discovery** that makes Traefik pleasant on a container fleet — and the reason its config is spread across dozens of `docker run` commands instead of one file.

## A middleware in effect: stripPrefix, headers, ratelimit

Middlewares are the part that replaces the repetitive `location` blocks you would otherwise write by hand. I attached three to a second service through labels alone:

```bash
$ docker run -d --name apisrv --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.api.rule=Host(`api.localhost`) && PathPrefix(`/api`)' \
    --label 'traefik.http.routers.api.middlewares=api-strip,secure-headers' \
    --label 'traefik.http.middlewares.api-strip.stripprefix.prefixes=/api' \
    --label traefik.http.middlewares.secure-headers.headers.framedeny=true \
    --label traefik.http.middlewares.secure-headers.headers.referrerpolicy=no-referrer \
    --label traefik.http.services.api.loadbalancer.server.port=80 \
    traefik/whoami:v1.10
```

The `middlewares=api-strip,secure-headers` label is the whole wiring: named middlewares are applied in order to anything this router matches. `stripPrefix` removes `/api` before the request reaches the backend — the container sees a different path than the client sent:

```bash
$ curl -s -H 'Host: api.localhost' http://127.0.0.1:18080/api/orders/42 | sed -n '4p'
GET /orders/42 HTTP/1.1
```

The `headers` middleware adds response headers. Over plain HTTP, HSTS is deliberately omitted (it only applies on TLS), but the other headers land:

```bash
$ curl -s -D - -o /dev/null -H 'Host: api.localhost' http://127.0.0.1:18080/api/ | grep -Ei 'referrer|x-frame'
Referrer-Policy: no-referrer
X-Frame-Options: DENY
```

And `ratelimit` is equally a label. I pointed a third router at the same service with `average=1`, `burst=1` and fired five requests:

```bash
$ for i in 1 2 3 4 5; do \
    curl -s -o /dev/null -w "request $i -> HTTP %{http_code}\n" \
      -H 'Host: limited.localhost' http://127.0.0.1:18080/; done
request 1 -> HTTP 200
request 2 -> HTTP 429
request 3 -> HTTP 429
request 4 -> HTTP 429
request 5 -> HTTP 429
```

One request gets through, the rest are rejected until the token refills. Other middlewares in the same family are `basicAuth` (which takes a `htpasswd`-style user list), `redirectScheme`/`redirectRegex` for HTTP→HTTPS and `/old → /new` moves, and `compress`. All of them are declared the same way: `traefik.http.middlewares.<name>.<type>.<option>`.

## The dashboard and the API

Because the config is assembled at runtime, "what is actually configured?" needs a live answer. Traefik exposes both a dashboard and a JSON API. With `--api.insecure=true` they sit on the API port I published:

```bash
$ curl -s http://127.0.0.1:18090/api/http/routers | ... # formatted
api@docker       rule=Host(`api.localhost`) && PathPrefix(`/api`)  ep=web  mw=api-strip@docker,secure-headers@docker  svc=api
limited@docker   rule=Host(`limited.localhost`)                     ep=web  mw=api-ratelimit@docker  svc=api
whoami@docker    rule=Host(`whoami.localhost`)                     ep=web  mw=  svc=whoami
```

Middlewares and services come from the same source of truth:

```bash
$ curl -s http://127.0.0.1:18090/api/http/middlewares
api-ratelimit@docker   type=ratelimit    {"rateLimit": {"average": 1, "burst": 1, "period": "1s"}}
api-strip@docker       type=stripprefix  {"stripPrefix": {"prefixes": ["/api"]}}
secure-headers@docker  type=headers      {"headers": {"frameDeny": true, "referrerPolicy": "no-referrer"}}

$ curl -s http://127.0.0.1:18090/api/entrypoints
traefik  address=:8080
web      address=:80
```

The `@docker` suffix tells you which provider an object came from — useful when a file provider and Docker are both live. In production you would not publish the API on an open port; you would put the `dashboard@internal` router behind a `basicAuth` middleware and TLS. But during a migration, that API is the fastest way to answer "why is this host 404" versus "which router owns it".

## TLS and ACME, and why localhost can't get a public cert

Traefik has **ACME** built in — it can obtain and renew Let's Encrypt certificates with no certbot and no cron. The static config adds an entrypoint, a resolver, and a store:

```bash
--entrypoints.websecure.address=:443
--certificatesresolvers.le.acme.email=you@example.com
--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
--certificatesresolvers.le.acme.httpchallenge.entrypoint=web
```

Then a router opts in with `traefik.http.routers.<name>.tls.certresolver=le`. The catch is unavoidable and worth stating plainly: ACME validates that **you control the domain**, and for the HTTP-01 challenge it fetches a token at `http://yourdomain/.well-known/acme-challenge/...`. There are no public CAs that will issue for `localhost`, `*.localhost`, or a private IP, because nobody can prove they own those names. That is why the lab above runs on plain HTTP — every certificate demo there would be theatre. To exercise ACME you need a real domain with a public DNS record pointing at a reachable host on ports 80/443; TLS-ALPN (port 443) works similarly but still needs the domain. For a self-hosted name that isn't public, the honest move is a private CA or a wildcard from your own internal PKI, not Let's Encrypt.

## Where Traefik shines, and where plain nginx is simpler

I would reach for Traefik when the fleet moves: dozens of containers coming and going, routes that should follow deployments, and one place to read the whole graph. The label model means a service is self-describing — delete the container and its route and middlewares vanish, so there is no orphaned config to clean up. That is genuinely better than hand-maintaining an nginx upstream list.

I would still reach for plain nginx when the fleet is small and stable. If you have one or two sites, a static file server, intricate `try_files`/SPA rewriting, or a config that a colleague already knows by heart, Traefik adds a layer of indirection — the config is now spread across container labels and a live API instead of a file you can `grep`. The [nginx config cookbook](/posts/nginx-cookbook/) is still where I go for location-matching subtleties, and [Caddy vs nginx](/posts/caddy-vs-nginx/) is the friendlier option when you want automatic HTTPS without a dynamic provider.

The one-line rule I use: **Traefik for a moving container fleet, nginx for a config that deserves to sit still.** The labels are what make the first case work — and once you have seen `Content-Type` and `X-Forwarded-For` lines arrive from a `docker run`, the "config from labels" idea stops being marketing and becomes something you can debug.
