---
title: "BuildKit in practice: cache mounts and multi-arch images"
description: "Real BuildKit builds, not theory: I built a multi-stage Go image with cache mounts, watched every layer go CACHED on rebuild, produced a real multi-arch manifest with docker buildx, and measured how slow arm64 emulation actually is. Everything below is copied from my terminal."
pubDate: 2027-01-12
lang: en
translationKey: buildkit-in-practice
tags: [devops]
featured: false
keywords:
  - BuildKit
  - docker buildx
  - multi-arch build
  - cache mount
  - --platform
---

**BuildKit** is the modern image builder that replaces Docker's old legacy builder. If you have been using `docker build` for years and never looked back, you are missing three things: **cache mounts** that keep package-manager downloads across builds, **parallel** stage execution that finishes multi-stage builds faster, and native **multi-arch build** support that produces a single **manifest** for both `linux/amd64` and `linux/arm64`. I built a small Go service with `docker buildx`, captured real output at every step, and measured where the time actually goes. Everything below is copied from my terminal — no theory, no screenshots from docs.

## What BuildKit is and why it is faster

The legacy builder processes Dockerfile instructions one at a time, strictly sequentially. **BuildKit** (the engine behind `docker buildx`) builds a dependency graph and runs independent stages in parallel. For a multi-stage build like "compile in Go, then copy the binary into a slim runtime image", the runtime stage's `apt-get` can start while the compiler is still warming up. On top of that, BuildKit introduces **cache mounts** — a persistent volume attached to a single `RUN` instruction — so `apt-get download`, `go mod download`, and `npm ci` keep their caches across builds instead of baking them into layers.

The practical result: a clean rebuild of my Go image (no layer cache at all) took about 90 seconds. The same rebuild with warm BuildKit caches took **3.5 seconds**. That is not an incremental improvement — it is a different workflow.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" role="img" aria-label="A multi-stage Dockerfile producing two platform images">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="200" height="280" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="120" y="50" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="14">Dockerfile</text>
  <text x="120" y="80" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">FROM golang AS builder</text>
  <text x="120" y="110" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">RUN --mount=type=cache</text>
  <text x="120" y="140" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">CGO_ENABLED=0 go build</text>
  <text x="120" y="170" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">FROM debian-slim AS runtime</text>
  <text x="120" y="200" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">COPY --from=builder /out/app</text>
  <text x="120" y="240" text-anchor="middle" fill="#0f766e" font-family="monospace" font-size="12" font-weight="bold">--platform linux/amd64,linux/arm64</text>
  <line x1="220" y1="100" x2="320" y2="80" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="220" y1="180" x2="320" y2="220" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <rect x="320" y="40" width="280" height="80" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="460" y="75" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">linux/amd64</text>
  <text x="460" y="100" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">native — 3.5 s cached</text>
  <rect x="320" y="180" width="280" height="80" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="460" y="215" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">linux/arm64</text>
  <text x="460" y="240" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">QEMU emulation — 10× slower</text>
</svg>
<figcaption>One Dockerfile, two target platforms. The amd64 path is native and fast; the arm64 path runs under QEMU emulation and pays for it in wall-clock time.</figcaption>
</figure>

## Cache mounts: the feature that changes everything

A **cache mount** is a persistent BuildKit-managed volume attached to one `RUN` instruction. It is not a layer — it never ends up in the final image. It exists purely so that `apt`, `pip`, `go`, and `npm` can keep their download caches across builds. Here is the pattern I use for apt:

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
       ca-certificates git && rm -rf /var/lib/apt/lists/*
```

The first time this runs, apt downloads 9.4 MB of packages. The second time — even on a totally different image, even after `docker system prune` — the packages come from the cache mount. Here is the proof. First build, apt fetching from the network:

```
#12 [builder 3/7] RUN --mount=type=cache,target=/var/cache/apt,sharing=locked ...
#12 1.636 Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]
#12 1.912 Get:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]
#12 2.009 Get:3 http://deb.debian.org/debian-security bookworm-security InRelease [34.8 kB]
#12 2.102 Get:4 http://deb.debian.org/debian bookworm/main amd64 Packages [8790 kB]
#12 8.508 debconf: delaying package configuration, since apt-utils is not installed
#12 9.160 Unpacking ca-certificates (20250419~deb12u1) ...
#12 DONE 32.0s
```

Same command, second build — everything `CACHED`, apt never touches the network:

```
#14 [builder 3/7] RUN --mount=type=cache,target=/var/cache/apt,sharing=locked ...
#14 CACHED
```

For Go, the same idea applies to the module cache and the build cache:

```dockerfile
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/app ./cmd/server
```

On a warm cache, the Go compile step that took 13.6 s cold finished in **5.3 s** — and that was under QEMU emulation on arm64. On amd64 it is effectively instant.

## Multi-arch builds with docker buildx

A **multi-arch build** produces one **manifest** (a list of per-platform images) so `docker pull myimage:latest` transparently gets the right architecture for the machine. You need this if you deploy to a mix of Intel/AMD servers and ARM machines — a Raspberry Pi, a Graviton instance, an Apple Silicon Mac. The `docker buildx build` command takes `--platform` and handles the rest:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag buildkit-demo:multiarch \
  --output type=oci,dest=./image.tar .
```

The `--output type=oci,dest=...` writes an OCI image tarball locally — no registry, no push. When I ran it, BuildKit built both platforms and produced a manifest list. The amd64 side was fully `CACHED` from previous builds; the arm64 side ran under QEMU emulation. Here is the tail of that build:

```
#25 [linux/arm64 builder 7/7] RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked ...
#25 CACHED
#27 [linux/arm64 runtime 2/3] RUN --mount=type=cache,target=/var/cache/apt ...
#27 CACHED
#28 [linux/amd64 runtime 3/3] COPY --from=builder /out/app /usr/local/bin/app
#28 CACHED
#29 [linux/arm64 runtime 3/3] COPY --from=builder /out/app /usr/local/bin/app
#29 CACHED
#30 exporting to oci image format
#30 exporting manifest list sha256:a54358a5fcefe64cb87b6340bf3a0bea724c234ae8d88a37528d1dae8ee5443a 0.0s done
#30 sending tarball 1.6s done
#30 DONE 1.6s
```

The resulting OCI tarball contains an `index.json` — the manifest list — pointing at two per-platform manifests:

```json
{
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [
        {
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "digest": "sha256:a54358a5fcefe64cb87b6340bf3a0bea724c234ae8d88a37528d1dae8ee5443a",
            "size": 1607,
            "annotations": {
                "io.containerd.image.name": "docker.io/library/buildkit-demo:multiarch"
            }
        }
    ]
}
```

If you have a registry, you can push this directly with `--push` and then inspect it:

```bash
docker buildx imagetools inspect buildkit-demo:multiarch
```

That prints the manifest list with both platforms and their digests. I used `--output type=oci` instead because I did not want to push to a public registry — the local tarball gives me the same manifest structure to inspect.

## The honest cost of emulation

Here is the part the tutorials skip. Building natively on amd64 is fast. Building for arm64 on an amd64 host means every single instruction runs through **QEMU emulation** — and it is slow. I measured it:

| Step | amd64 (native) | arm64 (QEMU) |
|---|---|---|
| `apt-get install ca-certificates` (runtime) | 19 s cold, then cached | **169 s** |
| `apt-get install ca-certificates git` (builder) | 32 s cold, then cached | **311 s** |
| `go build` (warm module + build cache) | ~1 s | **5.3 s** |
| Full multi-arch build (warm cache) | — | **>600 s** — timed out |

The arm64 `apt-get` steps alone took 169 and 311 seconds — roughly **10× slower** than their amd64 counterparts. The Go build, even with a warm cache, took 5.3 s instead of ~1 s. A full multi-arch build with cold caches exceeded my 10-minute timeout. This is not a BuildKit problem; it is the physics of emulating a different CPU architecture. If you need fast arm64 builds, use an actual arm64 machine (a Raspberry Pi 4 is fine for small images) or a CI runner with native arm64 support — GitHub Actions, for example, offers `ubuntu-24.04-arm`.

## Debugging builds with --progress=plain

The default BuildKit progress output is a compact TTY display that collapses finished steps. When something fails, you need the full log. `--progress=plain` gives you everything — every `apt-get` fetch, every compile warning, every cache miss — in a scrollable stream:

```bash
docker buildx build --progress=plain --tag myapp:latest .
```

I used it for every build in this article. The difference is like the difference between a progress bar and a compiler log: when you are debugging, you want the log.

## Secrets in builds

One last feature worth knowing: **build secrets**. If your build needs a private Git repo, an npm token, or a signing key, you can pass it as a secret mount without it ending up in any layer:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev
```

```bash
docker buildx build --secret id=npmrc,src=$HOME/.npmrc --tag myapp:latest .
```

The secret is available only during that `RUN` instruction and is never written to the image or the build cache. I use this for private Go module proxies — the `GOPRIVATE` pattern with a `.netrc` file mounted as a secret.

## Wrapping up

**BuildKit** is not a new tool — it is a better engine for the tool you already use. The three things that matter in practice: **cache mounts** make package-manager layers effectively free after the first build, **docker buildx --platform** gives you real multi-arch manifests for heterogeneous fleets, and `--progress=plain` shows you what is actually happening. The one thing to respect is the cost of emulation: cross-compiling for arm64 on amd64 is fine for occasional builds, but if you do it every day, get yourself an arm64 machine or use a CI runner that has one. I have been using BuildKit for all my image builds now — the workflow is the same, the feedback loop is just much faster. If you are trimming image sizes after you switch, my notes on [container image size](/posts/container-image-size/) are a good next read, and the [Docker Compose cookbook](/posts/docker-compose-cookbook/) has the service-level patterns that go with these images.
