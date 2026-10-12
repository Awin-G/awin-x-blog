---
title: "Shrinking container image size, layer by layer: 1.35 GB down to 8 MB"
description: "One small Go service built five ways on the same host — single-stage golang, multi-stage distroless/alpine/scratch, a fat Debian stack — with the real docker images and docker history numbers pasted layer by layer. Also: COPY order, cache hits, .dockerignore, and when 20 MB is too small."
pubDate: 2026-12-19
lang: en
translationKey: container-image-size
tags: [devops]
featured: false
keywords:
  - container image size
  - multi-stage build
  - distroless
  - docker history
  - .dockerignore
---

I took one small Go service — a health endpoint, two tiny dependencies — and built it five different ways on the same machine, then measured each result with `docker images` and `docker history`. The worst was **1.35 GB**. The best was **7.95 MB**. Same program, same features, same host. **Container image size** is one of those numbers that is easy to ignore until a deploy takes nine minutes instead of three seconds, so this post is the accounting, layer by layer: where the megabytes come from, what a **multi-stage build** actually drops, how `distroless`, `alpine` and `scratch` compare, and how to read all of it out of **docker history**.

## Why container image size matters

Four costs scale with the image, and only one of them is disk:

- **Pull time.** At 20 Mbit/s, 1.35 GB is about nine minutes of network before the container runs; 8 MB is a little over three seconds. Shared layers help, but only for layers the node already has.
- **Cold starts and autoscaling.** A fresh node has to pull before it can answer. If your autoscaler takes 90 seconds to become useful, the image is often the reason.
- **Attack surface.** Every package in the base is code you ship and now have to patch. The `golang:1.23` base alone is 927 MB unpacked, and it carries a shell, a package manager, a compiler and a C toolchain — none of which a running Go binary needs.
- **Storage and bandwidth.** Registries bill for storage, and every node that pulls pays the bandwidth. Multiply 1.35 GB by ten deploys a day and a small fleet.

## Where the bytes actually come from

Here is the naive Dockerfile. One stage, everything ships:

```dockerfile
FROM golang:1.23          # 1.24 GB reported by docker images
WORKDIR /src
COPY . .
RUN go build -o /app ./...
CMD ["/app"]
```

```console
$ docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep sizedemo
sizedemo:naive        1.35GB
sizedemo:multistage   14.1MB
sizedemo:alpine       21.8MB
sizedemo:scratch      7.95MB
sizedemo:layers-bad   572MB
sizedemo:layers-good  537MB
```

`docker history` shows exactly where the 1.35 GB sits:

```console
$ docker history sizedemo:naive
IMAGE          CREATED          CREATED BY                                       SIZE      COMMENT
50b707acd047   12 minutes ago   /bin/sh -c #(nop)  CMD ["/app"]                  0B
078f104cfbcd   12 minutes ago   /bin/sh -c #(nop)  EXPOSE 8080                   0B
9b07b4f3180c   12 minutes ago   |1 GOPROXY=https://goproxy.cn,direct /bin/sh…    92.1MB
c1f7af6a6cc0   13 minutes ago   /bin/sh -c #(nop) COPY dir:2c88684b0f50c202f…    24.6kB
a4a8e2d02a18   13 minutes ago   /bin/sh -c #(nop) WORKDIR /src                    8.19kB
60deed95d388   14 months ago    WORKDIR /go                                      4.1kB     buildkit.dockerfile.v0
...
```

Three separate sources of bloat, all visible in those six lines:

- **The fat base.** The eleven layers below `WORKDIR /go` are `golang:1.23` — 927 MB of toolchain that ships to production.
- **The build toolchain and its cache in the same layer.** That 92.1 MB `RUN go build` layer is not the binary. The binary is 5.5 MB; the rest is Go's build cache (`/root/.cache/go-build`), which `go build` writes inside the layer and which you cannot delete afterwards.
- **One layer per `RUN`, and deletions that do not delete.** A layer is immutable. If you install something in one `RUN` and `rm` it in the next, the bytes stay in the earlier layer. Here is the same idea with Debian:

```dockerfile
# bad: cleanup in a later layer
FROM debian:bookworm-slim
RUN apt-get update
RUN apt-get install -y --no-install-recommends build-essential
RUN rm -rf /var/lib/apt/lists/*
```

```dockerfile
# good: install and clean in one RUN
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
```

```console
$ docker history sizedemo:layers-bad
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
c5f17e613c10   8 minutes ago   /bin/sh -c rm -rf /var/lib/apt/lists/*            20.5kB
7b414c164866   8 minutes ago   /bin/sh -c apt-get install -y --no-install-r…    319MB
ee94f9007749   9 minutes ago   /bin/sh -c apt-get update                        19.8MB
7c7b2c966bc9   7 days ago      # debian.sh --arch 'amd64' out/ 'bookworm' …     85.3MB    debuerreotype 0.17

$ docker history sizedemo:layers-good
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
a0d01049fd3f   5 minutes ago   /bin/sh -c apt-get update  && apt-get instal…    319MB
7c7b2c966bc9   7 days ago      # debian.sh --arch 'amd64' out/ 'bookworm' …     85.3MB    debuerreotype 0.17
```

The "cleanup" layer is 20.5 kB — a whiteout marker — while the 19.8 MB of `apt-get update` metadata it removed is still in the image above it. `docker images` agrees: 572 MB for the bad version, 537 MB for the good one. Same packages, 35 MB apart.

## Multi-stage build: build fat, ship thin

A **multi-stage build** lets the builder be as fat as it likes, then copies only the artifact into the final image. The builder stage never reaches the registry.

```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

```console
$ docker history sizedemo:multistage
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
b06b0fe9bf91   6 minutes ago   /bin/sh -c #(nop)  ENTRYPOINT ["/app"]           0B
4b61455d93d7   6 minutes ago   /bin/sh -c #(nop)  USER nonroot:nonroot          0B
1b3aafa8afee   6 minutes ago   /bin/sh -c #(nop)  EXPOSE 8080                   0B
e2fc9ebc7585   6 minutes ago   /bin/sh -c #(nop) COPY file:6e308bbd6fccc620…    5.51MB
afa5c872c891   N/A             bazel build //common:cacerts_debian12_amd64_…   319kB
<missing>      N/A             bazel build //common:os_release_debian12         16.4kB
<missing>      N/A             bazel build //static:nsswitch                    12.3kB
<missing>      N/A             bazel build @bookworm//tzdata/amd64:data_sta…    4.24MB
...
```

That is the whole image: a 5.51 MB copy of the binary on top of ~5.4 MB of distroless layers. `-ldflags="-s -w"` strips symbols and DWARF, and `-trimpath` keeps local paths out of the binary.

> **A note on the numbers.** This host runs Docker 29 with the containerd image store, which counts both the compressed blob and the unpacked layers, so `docker images` reads about 1.3–1.4× the sum of `docker history`. I checked it with a scratch image holding one 1 MiB incompressible file: `docker images` says 2.1 MB, `docker history` says 1.05 MB. On a classic overlay2 host you would see roughly the `docker history` column below. The ratios — the whole point — are identical either way.

| Build | `docker images` | Sum of `docker history` |
| --- | --- | --- |
| single-stage `golang:1.23` | 1.35 GB | 1019 MB |
| multi-stage → `distroless/static` | 14.1 MB | 11.0 MB |
| multi-stage → `alpine:3.20` | 21.8 MB | 15.4 MB |
| multi-stage → `scratch` | 7.95 MB | 5.5 MB |

## Choosing a base: debian-slim vs alpine vs distroless vs scratch

The builder is cheap to throw away; the runtime base is the choice you live with.

| Base | Unpacked | libc | Shell / package manager | Notes |
| --- | --- | --- | --- | --- |
| `golang:1.23` | 927 MB | glibc | yes / apt | build stage only |
| `debian:bookworm-slim` | 85 MB | glibc | yes / apt | safest "normal" runtime |
| `alpine:3.20` | 8.5 MB | musl | busybox sh / apk | tiny, but musl |
| `distroless/static` | ~5.4 MB | none | no | ca-certs + tzdata, nonroot user |
| `scratch` | 0 | none | no | you add everything, including certs |

- **glibc vs musl.** Alpine is musl. A statically linked binary does not care, but if you `cgo` or rely on glibc's NSS resolver behaviour (some LDAP / mDNS setups), Alpine will surprise you. `debian-slim` and `distroless` give you glibc.
- **A shell is a debugging tool.** `distroless` and `scratch` have no shell:

```console
$ docker run --rm --entrypoint /bin/sh gcr.io/distroless/static-debian12:nonroot -c 'echo hi'
docker: Error response from daemon: ... exec: "/bin/sh": stat /bin/sh: no such file or directory

$ docker run --rm --entrypoint /bin/sh sizedemo:scratch -c 'echo hi'
docker: Error response from daemon: ... exec: "/bin/sh": stat /bin/sh: no such file or directory

$ docker run --rm --entrypoint /bin/sh sizedemo:alpine -c 'echo hi'
hi
```

- **`scratch` means nothing.** No CA certificates, no `/etc/passwd`, no timezone data, and unless you `USER` a numeric uid, you run as root. `distroless` is the pragmatic middle: it is `scratch` plus the four things above, already non-root.

<figure>
<svg viewBox="0 0 760 340" width="100%" role="img" aria-label="Layer stacks for the same Go service, three ways. Left: a single-stage image, 1.35 GB, where a 927 MB golang toolchain base and a 92 MB RUN layer holding the binary plus the Go build cache both ship. Middle: a multi-stage build to a distroless runtime, 14.1 MB, a 6.2 MB base plus the binary. Right: a scratch image, 7.95 MB, holding only the binary.">
  <g font-family="system-ui, sans-serif" fill="currentColor">
    <text x="105" y="22" text-anchor="middle" font-size="13" font-weight="600">Single stage</text>
    <text x="105" y="38" text-anchor="middle" font-size="11" opacity="0.65">one image, everything ships</text>
    <text x="395" y="22" text-anchor="middle" font-size="13" font-weight="600">Multi-stage → distroless</text>
    <text x="395" y="38" text-anchor="middle" font-size="11" opacity="0.65">builder discarded</text>
    <text x="675" y="22" text-anchor="middle" font-size="13" font-weight="600">Multi-stage → scratch</text>
    <text x="675" y="38" text-anchor="middle" font-size="11" opacity="0.65">builder discarded</text>

    <rect x="40" y="95" width="130" height="185" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="40" y1="130" x2="170" y2="130" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="165" x2="170" y2="165" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="200" x2="170" y2="200" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="235" x2="170" y2="235" stroke="currentColor" opacity="0.18"/>
    <text x="105" y="178" text-anchor="middle" font-size="11" opacity="0.85">golang:1.23</text>
    <text x="105" y="194" text-anchor="middle" font-size="11" opacity="0.85">toolchain base</text>
    <text x="105" y="210" text-anchor="middle" font-size="11" opacity="0.6">927 MB</text>

    <rect x="40" y="76.6" width="130" height="18.4" fill="#0f766e" opacity="0.9"/>
    <text x="105" y="89" text-anchor="middle" font-size="10" fill="#ffffff">92 MB</text>
    <line x1="172" y1="86" x2="206" y2="86" stroke="currentColor" opacity="0.5"/>
    <text x="212" y="83" font-size="10" opacity="0.8">one RUN layer</text>
    <text x="212" y="96" font-size="10" opacity="0.8">binary + build cache</text>

    <rect x="330" y="270" width="130" height="5" fill="currentColor" opacity="0.14" stroke="currentColor" stroke-opacity="0.5"/>
    <rect x="330" y="275" width="130" height="5" fill="#0f766e" opacity="0.9"/>
    <line x1="395" y1="264" x2="395" y2="270" stroke="currentColor" opacity="0.4"/>
    <text x="395" y="246" text-anchor="middle" font-size="10" opacity="0.85">distroless base 6.2 MB</text>
    <text x="395" y="259" text-anchor="middle" font-size="10" opacity="0.85">+ binary 5.5 MB</text>

    <rect x="610" y="272" width="130" height="8" fill="#0f766e" opacity="0.9"/>
    <text x="675" y="253" text-anchor="middle" font-size="10" opacity="0.85">binary 5.5 MB</text>

    <line x1="24" y1="280" x2="736" y2="280" stroke="currentColor" stroke-width="1" opacity="0.35"/>

    <g font-size="11" font-weight="600" fill="#0f766e">
      <text x="105" y="298" text-anchor="middle">1.35 GB</text>
      <text x="395" y="298" text-anchor="middle">14.1 MB</text>
      <text x="675" y="298" text-anchor="middle">7.95 MB</text>
    </g>
    <g font-size="10" opacity="0.65">
      <text x="105" y="313" text-anchor="middle">1019 MB unpacked</text>
      <text x="395" y="313" text-anchor="middle">11.0 MB unpacked</text>
      <text x="675" y="313" text-anchor="middle">5.5 MB unpacked</text>
    </g>
    <text x="380" y="332" text-anchor="middle" font-size="10" opacity="0.55">≈ 0.2 px per MB vertically; bars under 6 px drawn at 6 px so the thin stacks stay visible</text>
  </g>
</svg>
<figcaption>
  The same Go service, three build strategies. The single-stage image ships the
  927 MB toolchain base and a 92 MB RUN layer (the 5.5 MB binary plus ~86 MB of Go
  build cache); the multi-stage variants ship only a small base and the binary.
  Sizes come from <code>docker images</code> and <code>docker history</code>.
</figcaption>
</figure>

## Instruction order changes docker history and the cache

The same instructions in a different order change how much of the image the cache can reuse. `COPY . .` before `go mod download` means any source edit — even a README — invalidates the download layer too:

```dockerfile
# cache-hostile
COPY . .
RUN go mod download
RUN go build -o /app ./...
```

```dockerfile
# cache-friendly
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /app ./...
```

Build both, then edit `README.md` and rebuild. Friendly version:

```console
Step 4/7 : COPY go.mod go.sum ./
 ---> Using cache
Step 5/7 : RUN go mod download
 ---> Using cache
Step 6/7 : COPY . .
 ---> dcfa290888f3
Step 7/7 : RUN CGO_ENABLED=0 go build ...
 ---> Running in ac7b2a5acc56
```

Hostile version, same edit:

```console
Step 4/6 : COPY . .
 ---> 67f4c393ba1a
Step 5/6 : RUN go mod download
 ---> Running in 593cf506afae
Step 6/6 : RUN CGO_ENABLED=0 go build ...
 ---> Running in 1eedbea7f723
```

Two lessons. First, copy the dependency manifest before the source so the expensive "fetch dependencies" step survives ordinary edits. Second, `docker history` and the build cache read the same layer graph, so the ordering that shrinks the image is usually the ordering that caches well.

## `.dockerignore` is the cheapest win

`COPY . .` copies the build context — including things you never meant to ship. A 43 MB context with a stray `debug.log` and a `node_modules/`:

```console
$ du -sh ctx
43M	ctx

$ docker build -f Dockerfile.ctx -t szprobe:ctx-raw ctx      # COPY . /
$ docker build -f Dockerfile.ctx -t szprobe:ctx-ignored ctx  # with .dockerignore

$ docker history szprobe:ctx-raw     | head -1
3433821b1065   ...   /bin/sh -c #(nop) COPY dir:...   44.1MB
$ docker history szprobe:ctx-ignored | head -1
4dd05186d44a   ...   /bin/sh -c #(nop) COPY dir:...   12.3kB
```

`.dockerignore` with `debug.log` and `node_modules/` took the copied layer from 44.1 MB to 12.3 kB. Always ignore `.git`, `node_modules`, build output, local env files and logs. It also speeds up the build: the context is sent to the daemon before anything runs.

## The honest note: a 20 MB image you cannot debug

The smallest image is not automatically the best one. `scratch` and `distroless` have no shell, no `ps`, no `curl`, no `nc`. During an incident you cannot `docker exec` in and poke around; you get a debug-only variant (`distroless:debug`) or a sidecar with tools. That has a real cost the byte counter does not show. Stripping symbols with `-s -w` also makes stack traces worse unless you keep the unstripped binary elsewhere for symbolisation.

My rule: ship `distroless` (or `scratch` for a static binary with no runtime needs), keep a debug image tag for the same build, and never trade away observability you actually use to save megabytes you would not notice. A 20 MB image you cannot debug is not better than a 60 MB image you can.

If the build itself is where you spend your time, the [Docker Compose cookbook](/posts/docker-compose-cookbook/) covers the surrounding workflow, and if you are trimming your image for security rather than size, [what a container does and doesn't protect](/posts/container-security/) is the useful companion — a smaller image is a smaller attack surface, but it is not a security boundary.
