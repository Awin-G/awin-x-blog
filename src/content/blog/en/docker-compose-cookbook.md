---
title: "Docker Compose cookbook: the parts people actually get wrong"
description: "A hands-on Docker Compose cookbook: why version is obsolete, build vs image, depends_on healthcheck ordering, named volumes vs bind mounts, .env and env_file, secrets, profiles, resource limits and docker compose config — all verified with real output from a stack I actually ran."
pubDate: 2026-12-09
lang: en
translationKey: docker-compose-cookbook
tags: [devops, self-hosting]
featured: false
keywords:
  - docker compose
  - compose.yaml
  - depends_on healthcheck
  - docker compose up
  - named volumes
---

Most Docker Compose problems I get asked about aren't exotic. They are the same dozen small misunderstandings: a `version:` key that does nothing, a `depends_on` that "doesn't work", a volume that quietly isn't where the data is. So I built one small stack on this machine — an nginx edge in front of a tiny Python app that counts visits in Redis — and wrote down what `docker compose up` actually does, with the output pasted in verbatim. Docker 29.9.0, Compose v5.6.0, no `sudo`, every port bound to `127.0.0.1`. The `compose.yaml` below is the one I ran. If you would rather not run containers at all, I covered the systemd-and-nginx road in [Self-hosting without Docker](/posts/self-hosting-without-docker/); this is the other one.

<figure>
<svg viewBox="0 0 760 330" role="img" aria-label="Service topology: a client reaches web on 127.0.0.1:8080, web proxies to app over the edge network, app reaches redis over an internal backend network, and redis persists to a named volume">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="20" y="72" width="480" height="100" rx="10" stroke-dasharray="5 4" opacity="0.45"/>
    <rect x="270" y="186" width="480" height="104" rx="10" stroke-dasharray="5 4" opacity="0.45"/>
    <rect x="60" y="18" width="180" height="36" rx="8"/>
    <rect x="60" y="98" width="180" height="52" rx="8"/>
    <rect x="330" y="98" width="170" height="150" rx="8"/>
    <rect x="590" y="200" width="160" height="56" rx="8"/>
    <rect x="590" y="286" width="160" height="34" rx="8" stroke-dasharray="3 3"/>
  </g>
  <g fill="currentColor" stroke="currentColor" stroke-width="1.4" marker-end="url(#arw)">
    <line x1="150" y1="54" x2="150" y2="94"/>
    <line x1="240" y1="124" x2="326" y2="132"/>
    <line x1="500" y1="215" x2="586" y2="228"/>
    <line x1="670" y1="256" x2="670" y2="284"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" text-anchor="middle">
    <text x="150" y="41" font-size="12">curl 127.0.0.1:8080</text>
    <text x="150" y="129" font-size="15">web</text>
    <text x="415" y="178" font-size="15">app</text>
    <text x="670" y="233" font-size="15">redis</text>
    <text x="670" y="308" font-size="11">redis-data</text>
  </g>
  <g fill="currentColor" font-size="11" text-anchor="middle" opacity="0.85">
    <text x="285" y="113">proxy_pass app:8080</text>
    <text x="543" y="207">REDIS_HOST=redis</text>
  </g>
  <g fill="currentColor" font-size="12" opacity="0.7">
    <text x="32" y="90">network: edge</text>
    <text x="282" y="205">network: backend (internal: true)</text>
  </g>
</svg>
<figcaption>One stack, two networks. <code>app</code> is attached to both; <code>redis</code> only sees the internal backend. Solid arrows are TCP calls, and the only thing exposed to the host is web on <code>127.0.0.1:8080</code>.</figcaption>
</figure>

## What a modern compose.yaml looks like: services, not version

The Compose v1 file format started at `version: "2"` and grew to `"3.8"`. Those keys are dead. The Compose Specification has one required top-level key, `services:`, and version is not one of them. Proving it takes one command. Here is a file with a `version:` header:

```yaml
version: "3.8"

services:
  web:
    image: nginx:1.27-alpine
```

And here is what Compose does with it:

```console
$ docker compose -f compose.v1.yaml config
time="2026-10-12T17:08:33+08:00" level=warning msg=".../compose.v1.yaml: the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion"
name: compose-cookbook
services:
  web:
    image: nginx:1.27-alpine
    networks:
      default: null
networks:
  default:
    name: compose-cookbook_default
```

Ignored, with a warning. Two things replaced the old top-level keys: the project name now comes from a `name:` key (or the directory name, or `COMPOSE_PROJECT_NAME`), and the file is conventionally `compose.yaml` — Compose also still accepts `docker-compose.yml`, but new files should just be `compose.yaml`.

## build vs image: pick your source of truth

`image:` alone means "pull it". `build:` alone means "build it", and Compose invents a name like `compose-cookbook-app`. When you set both, Compose builds from `build:` and tags the result as `image:` — which is what you want in production, because then a later `docker compose pull` or a registry reference actually resolves. That is exactly what the app service does:

```yaml
  app:
    build:
      context: ./app
    image: compose-cookbook/app:${TAG}
```

The build ends with the tag I asked for:

```console
Successfully built f4ab273c31bf
Successfully tagged compose-cookbook/app:1.0
```

Ask Compose what it will use before it runs anything:

```console
$ docker compose config --images
nginx:1.27-alpine
compose-cookbook/app:1.0
redis:7-alpine
```

One environment note: on this box the buildx plugin was missing, so Compose printed `buildx Docker CLI plugin not found: falling back to the classic builder` and built anyway. `build:` is not BuildKit-specific.

## depends_on healthcheck: ordering is not readiness

This is the single most common complaint, so let me be precise. A bare `depends_on` waits for the dependency's **container** to start — not for the process inside it to be ready. Redis takes a moment to bind its port; nginx or your app can win the race and crash on the first connection.

`condition: service_healthy` is the fix, and it needs a healthcheck to aim at. Both ends, from my `compose.yaml`:

```yaml
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/health').read()"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s
```

Now watch a real `docker compose up` honour the chain. Compose starts Redis, *waits*, sees it healthy, only then starts the app, waits again, and finally starts nginx:

```console
$ docker compose up -d --build
 Container compose-cookbook-redis-1 Starting
 Container compose-cookbook-redis-1 Started
 Container compose-cookbook-redis-1 Waiting
 Container compose-cookbook-redis-1 Healthy
 Container compose-cookbook-app-1 Starting
 Container compose-cookbook-app-1 Started
 Container compose-cookbook-app-1 Waiting
 Container compose-cookbook-app-1 Healthy
 Container compose-cookbook-web-1 Starting
 Container compose-cookbook-web-1 Started
```

The `Waiting` → `Healthy` → `Starting` ladder is the whole feature. `docker compose up -d --wait` goes one better and blocks until *every* service with a healthcheck reports healthy, which is what you want in CI.

Two gotchas worth knowing: add a `start_period` for slow-booting services, or the first few failures count against `retries`; and healthchecks poll on an interval, so `docker compose logs` fills up with the probe requests — the `GET /health` lines below are the probes, not traffic:

```console
$ docker compose logs --tail 3
web-1  | 127.0.0.1 - - [12/Oct/2026:09:11:21 +0000] "GET /health HTTP/1.1" 200 3 "-" "Wget" "-"
web-1  | 127.0.0.1 - - [12/Oct/2026:09:11:26 +0000] "GET /health HTTP/1.1" 200 3 "-" "Wget" "-"
redis-1  | 1:M 12 Oct 2026 09:10:17.931 * Ready to accept connections tcp
```

## docker compose up: named volumes vs bind mounts

Both live under `services.<name>.volumes`, but they are different things, and `docker compose config` shows which is which after normalising:

```yaml
    volumes:
      - redis-data:/data
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
```

renders as:

```console
      - type: volume
        source: redis-data
        target: /data
      - type: bind
        source: /tmp/opencode/work/compose-cookbook/nginx/default.conf
        target: /etc/nginx/conf.d/default.conf
        read_only: true
```

A **named volume** is Docker-managed storage with a lifecycle independent of any container. `docker compose down` leaves it in place, so my visit counter kept climbing across a full teardown; only `-v` removes it:

```console
$ docker compose down            # counter survives, next request is visits=5
$ docker compose down -v
 Volume compose-cookbook_redis-data Removing
 Volume compose-cookbook_redis-data Removed
$ docker compose up -d --wait && curl -s http://127.0.0.1:8080/
visits=1
```

A **bind mount** is a path from the host, and it brings host problems with it: file ownership is the host's UID, and a `:ro` mount breaks anything that tries to rewrite it. nginx tells you out loud:

```console
web-1 | 10-listen-on-ipv6-by-default.sh: info: can not modify /etc/nginx/conf.d/default.conf (read-only file system?)
```

Harmless here, confusing if you don't know why. Rule of thumb: named volumes for data the container owns, bind mounts for config and source you edit on the host.

## environment, .env, and env_file

Three different things, one name, endless confusion.

- `.env` in the project directory feeds **Compose's own interpolation** (`${APP_PORT}`). It never reaches a container.
- `environment:` sets variables on the container, inline in the compose file.
- `env_file:` loads a file of `KEY=value` lines into the container.

My `.env` holds `APP_PORT=8080` and `TAG=1.0`, so `ports: ["127.0.0.1:${APP_PORT}:80"]` resolves to a real published port:

```console
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 80
        published: "8080"
```

`env_file: [app.env]` plus an inline `environment:` merge into the container's environment — `env_file` provides the defaults, `environment` wins on collisions:

```console
$ docker compose exec -T app env | grep -E 'COUNTER_KEY|REDIS_'
COUNTER_KEY=visits
REDIS_HOST=redis
REDIS_PORT=6379
```

The sharp edge is an unset variable. Compose warns and substitutes an empty string, and the port silently loses its `published` value instead of failing:

```console
$ docker compose -f bad-var.yaml config
level=warning msg="The \"NOT_SET_ANYWHERE\" variable is not set. Defaulting to a blank string."
...
      - mode: ingress
        host_ip: 127.0.0.1
        target: 80
        protocol: tcp
```

## secrets vs environment: stop putting passwords in env

Environment variables are not secrets. `docker compose config` prints every environment value in cleartext — mine shows `REDIS_HOST: redis` in full — and so does `docker inspect`. Compose has `secrets:` for the things that are actually secret. I gave Redis a password and mounted it as a file both Redis and the app read at `/run/secrets/redis_password`:

```console
$ docker compose exec -T redis env | grep -iE 'pass|secret'
$ echo $?
1
$ docker compose exec -T redis ls -l /run/secrets/
total 4
-rw-r--r--    1 1000     redis           33 Oct 12 09:06 redis_password
```

No password in the environment, and `docker compose config` shows the secret only as a *file path*, never its contents. Honest caveat: outside Swarm, Compose secrets are just files mounted from disk — the win is anatomical, keeping values out of env and `inspect`, not magic encryption. The app reads the file and sends `AUTH`; Redis starts with `--requirepass "$(cat /run/secrets/redis_password)"`.

## Networks and service-name DNS

Every project gets a `default` network, and containers on it can reach each other by **service name**. But one network for everything means your front end can also reach your database directly. I split them:

```yaml
networks:
  edge:
  backend:
    internal: true
```

`web` is only on `edge`; `redis` only on `backend`; `app` sits on both. The name resolution rule is embedded DNS at `127.0.0.11`, and it only knows the containers on the networks it is attached to:

```console
$ docker compose exec -T web nslookup app
Name:	app
Address: 172.23.0.2
$ docker compose exec -T web nslookup redis
** server can't find redis: NXDOMAIN
```

That `NXDOMAIN` is the segmentation working. For the DNS and NAT plumbing underneath it, see [Docker networking explained](/posts/docker-networking/).

## Profiles: services that only exist when you ask

A `debug-tools` service tagged `profiles: [debug]` is invisible until you name the profile. That is how you keep one-off tools in the same file without running them in production:

```console
$ docker compose config --profiles
debug
$ docker compose config --services
redis
app
web
$ docker compose up -d            # debug-tools is not created
$ docker compose --profile debug up -d
 Container compose-cookbook-debug-tools-1 Started
```

Profiles have a trap that bit me during cleanup: `docker compose down` ignores inactive profiles, so the profiled container and its network survived my first teardown. Fully removing a profiled stack needs the profile named again — `docker compose --profile debug down -v`.

## Resource limits that plain docker compose up honours

`deploy.resources.limits` used to be Swarm-only. Compose now applies `cpus` and `memory` on `docker compose up` too, and `docker stats` shows the ceiling directly:

```yaml
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 128M
```

```console
$ docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
NAME                             MEM USAGE / LIMIT
compose-cookbook-web-1           8.641MiB / 128MiB
compose-cookbook-redis-1         8.379MiB / 11.56GiB
```

The web container is capped; Redis, with no `deploy` block, shows the host total. The runtime agrees:

```console
$ docker inspect compose-cookbook-web-1 --format 'Memory={{.HostConfig.Memory}} NanoCpus={{.HostConfig.NanoCpus}}'
Memory=134217728 NanoCpus=500000000
```

## Verify with docker compose config before you ship

`docker compose config` renders the fully-resolved, canonical version of your file: interpolation applied, profiles filtered, `depends_on` normalised, secrets expanded to paths. Run it in CI before anything starts. It catches real mistakes. An undefined network:

```console
$ docker compose config
service "web" refers to undefined network nope: invalid compose project
```

Exit code non-zero, no containers touched. It is the cheapest preflight in the whole toolchain, and it is also your answer when a variable or an override is not doing what you think it is.

## Override files: compose.override.yaml and -f

Compose auto-loads `compose.override.yaml` next to `compose.yaml`. It is the intended place for local tweaks you do not want to commit into the base. I added a second port and an env var in one:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:9090:80"
    environment:
      NGINX_ENTRYPOINT_QUIET_LOGS: "1"
```

Lists merge, so both ports survive — and here is the trap: the override is loaded *only* when you do not pass `-f` yourself.

```console
$ docker compose config | grep -E 'published|NGINX_ENTRYPOINT'
      NGINX_ENTRYPOINT_QUIET_LOGS: "1"
        published: "8080"
        published: "9090"
$ docker compose -f compose.yaml config | grep -E 'published|NGINX_ENTRYPOINT'
        published: "8080"
```

If your `-f` command line behaves differently from a bare `docker compose up`, that is why. For explicit layering, name every file: `docker compose -f compose.yaml -f compose.prod.yaml up -d`.

## Restart policies, depends_on at runtime, and down -v

`depends_on` orders **creation**. It does nothing after that — nothing restarts a dependent when its dependency dies. Two experiments proved it on my stack. Killing the container out from under the app:

```console
$ docker inspect compose-cookbook-redis-1 --format '{{.HostConfig.RestartPolicy.Name}}'
unless-stopped
$ docker kill compose-cookbook-redis-1
$ docker compose ps -a --format 'table {{.Service}}\t{{.Status}}'
redis         Exited (137) 9 seconds ago
$ docker inspect compose-cookbook-redis-1 --format 'RestartCount={{.RestartCount}}'
RestartCount=0
```

No restart: `docker kill` is a *manual* stop, and both `unless-stopped` and `always` treat manual stops as final. Nor can you simulate a crash from inside — the kernel ignores `kill -9` sent to PID 1 of a container's namespace:

```console
$ docker exec sigtest sh -c 'kill -9 1'; docker inspect sigtest --format '{{.State.Status}}'
running
```

Only a process that actually exits does a policy fire. A failing service with `restart: on-failure` climbed as expected:

```console
$ docker inspect compose-cookbook-flaky-1 --format 'RestartCount={{.RestartCount}}'
RestartCount=6
```

So: `restart: unless-stopped` for anything stateful, and remember the difference from `always` is only at daemon start — `always` brings back a manually stopped container, `unless-stopped` leaves it down.

## The short version

`services:` is the file, `version:` is noise. `build` + `image` together keeps builds reproducible and pullable. `depends_on` with `condition: service_healthy` is the only ordering that waits for *readiness*, and it is creation-time only. Named volumes hold data across `down`; bind mounts hold your host's permissions. `.env` is for Compose, `env_file` is for containers, secrets belong in neither environment nor `env_file`. Networks give you service-name DNS and segmentation for free. Profiles keep tools out of production. Run `docker compose config` before you trust any of it, and know that `down -v` deletes the named volumes while `down` does not. That is the whole cookbook — the rest is just reading the output Compose already prints.
