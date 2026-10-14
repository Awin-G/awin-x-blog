---
title: "Container Image Layers and Digests: What Is Actually Inside an Image"
description: "A container image is an ordered stack of filesystem layers plus a config. Learn how Dockerfiles map to layers, why layer order matters for cache reuse, and the difference between tags and digests."
pubDate: 2027-01-29
lang: en
translationKey: container-image-layers-and-digests
tags: [devops]
featured: false
keywords:
  - container image layers
  - image digest
  - docker history
  - layer cache
  - docker save
---

# Container Image Layers and Digests: What Is Actually Inside an Image

## Introduction

When you pull a container image, you're not downloading a single monolithic file. You're fetching an ordered stack of filesystem layers — each one a diff that transforms the filesystem in some way — plus a small JSON config file that ties them all together. Understanding this structure is the key to building smaller images, debugging build failures, and making sense of why your rebuilds are fast (or painfully slow).

I've written before about [keeping container images small](/posts/container-image-size/) and [signing them for supply-chain security](/posts/container-image-signing/). This post goes one level deeper: what is actually inside an image, how the Dockerfile maps to layers, and why the difference between a tag and a digest matters in production.

## An image is an ordered stack of layers + a config

Let me start with a minimal Dockerfile:

```dockerfile
FROM alpine:3.20
RUN echo "layer 1: base packages" > /tmp/layer1.txt
RUN echo "layer 2: dependencies" > /tmp/layer2.txt
RUN echo "layer 3: application code" > /tmp/layer3.txt
```

When I build this, Docker creates four layers: one for the base image, and one for each `RUN` instruction. Each layer is a filesystem diff — a set of file additions, modifications, and deletions relative to the layer below it. The layers are stacked in order, and the result is the final filesystem you see when you run a container.

Here's what `docker history` shows for this image:

```
IMAGE                                                                     CREATED         CREATED BY                                                                     SIZE      COMMENT
sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e   6 seconds ago   RUN /bin/sh -c echo "layer 3: application code" > /tmp/layer3.txt # buildkit   12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 seconds ago   RUN /bin/sh -c echo "layer 2: dependencies" > /tmp/layer2.txt # buildkit       12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 seconds ago   RUN /bin/sh -c echo "layer 1: base packages" > /tmp/layer1.txt # buildkit      12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 months ago    CMD ["/bin/sh"]                                                                0B        buildkit.dockerfile.v0
<missing>                                                                 6 months ago    ADD alpine-minirootfs-3.20.10-x86_64.tar.gz / # buildkit                       8.47MB    buildkit.dockerfile.v0
```

Each row is a layer. The `CREATED BY` column shows the instruction that created it. The `SIZE` column shows how much disk space that layer adds. The base image layer (the `ADD` of the alpine minirootfs) is 8.47 MB; each of my `RUN` layers adds about 12.3 kB.

But `docker history` is a high-level view. To see the actual layer identifiers, I need `docker inspect`:

```json
["sha256:08bc4e534116aa76b16015484b82eac51f9a593416feae9296c8a2d4bb7aa4a2","sha256:15557c6af6d921a21adddf322fc6ff6af50bcb44c297284f1c97eed5b618320c","sha256:6c478fc0094f343465131e664ccd4f63ae420e7d6fb45e1ee18a41ec3de78008","sha256:5568d20119c078835bdbf777e6a55eca93e3ee7962654058a9bbd362df1f7b87"]
```

These are the `diff_ids` — the content-addressed identifiers of each layer. Each one is a SHA-256 hash of the layer's uncompressed tarball. If the content changes, the hash changes. This is what makes layers immutable and cacheable.

<figure>
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Container image layer stack diagram">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="39" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">config.json</text>
  <line x1="180" y1="52" x2="180" y2="66" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="40" y="68" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="91" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 3: app code</text>
  <text x="330" y="91" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:5568…</text>
  <rect x="40" y="112" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="135" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 2: dependencies</text>
  <text x="330" y="135" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:6c47…</text>
  <rect x="40" y="156" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="179" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 1: base packages</text>
  <text x="330" y="179" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:1555…</text>
  <rect x="40" y="200" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="223" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">base: alpine:3.20</text>
  <text x="330" y="223" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:08bc…</text>
</svg>
<figcaption>FIG. 1 — A container image is an ordered stack of layers, each content-addressed by a digest, plus a config that ties them together.</figcaption>
</figure>

## How the Dockerfile maps to layers

The rule of thumb is: **one instruction ≈ one layer**. Each `RUN`, `COPY`, `ADD`, and `WORKDIR` instruction creates a new layer. But there are exceptions:

- `FROM` doesn't create a layer — it references the base image's layers.
- `ENV`, `LABEL`, `EXPOSE`, `CMD`, `ENTRYPOINT` don't create filesystem layers — they only modify the image config.
- Multi-stage builds let you copy files from one stage to another, creating a new layer with just the copied files.

The key insight is that layers are **filesystem diffs**. A `RUN` instruction that modifies files creates a layer containing those modifications. A `COPY` instruction creates a layer containing the copied files. Instructions that only set metadata don't create filesystem layers at all.

## Why layer ORDER matters for layer cache reuse

Docker caches layers based on the instruction and the layers below it. If you change an instruction, that layer and all subsequent layers are rebuilt. This is why the order of instructions in your Dockerfile matters so much.

Let me demonstrate. I'll build the image again — this time, everything is cached:

```
#5 [2/4] RUN echo "layer 1: base packages" > /tmp/layer1.txt
#5 CACHED

#6 [3/4] RUN echo "layer 2: dependencies" > /tmp/layer2.txt
#6 CACHED

#7 [4/4] RUN echo "layer 3: application code" > /tmp/layer3.txt
#7 CACHED
```

Now I'll change the second instruction and rebuild:

```dockerfile
FROM alpine:3.20
RUN echo "layer 1: base packages" > /tmp/layer1.txt
RUN echo "layer 2: CHANGED dependencies" > /tmp/layer2.txt
RUN echo "layer 3: application code" > /tmp/layer3.txt
```

```
#5 [2/4] RUN echo "layer 1: base packages" > /tmp/layer1.txt
#5 CACHED

#6 [3/4] RUN echo "layer 2: CHANGED dependencies" > /tmp/layer2.txt
#6 DONE 0.3s

#7 [4/4] RUN echo "layer 3: application code" > /tmp/layer3.txt
#7 DONE 0.4s
```

The first layer is still cached. The second layer is rebuilt because its instruction changed. The third layer is also rebuilt — even though its instruction didn't change — because it sits on top of a changed layer. This is the classic cache invalidation cascade.

The practical rule: **order your instructions from least-changing to most-changing**. Put stable instructions (base image, system packages) at the top, and volatile instructions (application code, config) at the bottom. This way, when you change your code, only the top layers rebuild.

## Tags are mutable pointers, digests are immutable

A tag like `layerdemo:1.0` is just a pointer to an image digest. The digest is the SHA-256 hash of the image manifest — a JSON file that lists the layers and config. When you pull by tag, Docker resolves the tag to a digest, then downloads the layers.

Here's what `docker images --digests` shows:

```
REPOSITORY   TAG       DIGEST                                                                    IMAGE ID       CREATED          SIZE
layerdemo    1.1       sha256:93e5d1a900d1b55462a5aa647321faf68bd172474d495487fc203f7adf79b2aa   93e5d1a900d1   17 seconds ago   12.1MB
layerdemo    1.0       sha256:5da614f4ff00d3b0f8cc63f87287a7101f3f6b314c21998b3bb4d64e396d44f2   5da614f4ff00   47 seconds ago   12.1MB
```

Both tags point to different digests. If I retag `layerdemo:1.0` to point to the `1.1` image, the tag moves but the digest stays the same. The digest is immutable — it's a hash of the content. The tag is mutable — it's just a label.

This is why you should pin digests in production:

```dockerfile
# Instead of this:
FROM alpine:3.20

# Do this:
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
```

When you pin a digest, you're saying "I want exactly this image, not whatever the tag currently points to." This protects you from unexpected changes when someone pushes a new image with the same tag.

## Inspecting layers with docker history and docker inspect

`docker history` gives you a human-readable view of the layers. `docker inspect` gives you the raw data. Here's what `docker inspect` shows for the image ID, digests, and size:

```
Id: sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e
RepoDigests: [layerdemo@sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e]
RepoTags: [layerdemo:1.0]
Created: 2026-10-14T10:23:53.661439017+08:00
Size: 12140611
Architecture: amd64
Os: linux
```

The `Id` is the image digest. The `RepoDigests` shows the digest with the repository name. The `RepoTags` shows the tags. The `Size` is the total size of all layers.

## The classic apt-get trap

The most famous layer cache trap is the `apt-get update` and `apt-get install` pattern. Consider this Dockerfile:

```dockerfile
# BAD - can use stale package lists
FROM alpine:3.20
RUN apk update
RUN apk add curl
```

If the `apk update` layer is cached, but the package lists have changed since it was built, the `apk add` layer will use the stale lists. This can lead to errors like "Unable to locate package" or "Hash sum mismatch".

The fix is to combine them in a single `RUN`:

```dockerfile
# GOOD - always uses fresh package lists
FROM alpine:3.20
RUN apk update && apk add curl
```

Now the package lists are always fresh when `apk add` runs, because they're in the same layer. If either command fails, the whole layer fails — no stale cache.

Here's what the bad pattern looks like when built:

```
#5 [2/3] RUN apk update
#5 0.236 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz
#5 1.009 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz
#5 1.661 OK: 24171 distinct packages available
#5 DONE 1.8s

#6 [3/3] RUN apk add curl
#6 0.593 (1/10) Installing ca-certificates (20260413-r0)
#6 1.911 (2/10) Installing brotli-libs (1.1.0-r2)
#6 14.57 (3/10) Installing c-ares (1.33.1-r0)
#6 17.73 (4/10) Installing libunistring (1.2-r0)
#6 37.08 (5/10) Installing libidn2 (2.3.7-r0)
#6 39.51 (6/10) Installing nghttp2-libs (1.62.1-r0)
#6 42.13 (7/10) Installing libpsl (0.21.5-r1)
#6 43.86 (8/10) Installing zstd-libs (1.5.6-r2)
#6 55.38 (9/10) Installing libcurl (8.14.1-r2)
#6 68.51 (10/10) Installing curl (8.14.1-r2)
#6 75.04 OK: 13 MiB in 24 packages
#6 DONE 75.1s
```

And the good pattern:

```
#5 [2/2] RUN apk update && apk add curl
#5 0.213 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz
#5 0.928 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz
#5 1.480 OK: 24171 distinct packages available
#5 1.877 (1/10) Installing ca-certificates (20260413-r0)
#5 2.431 (2/10) Installing brotli-libs (1.1.0-r2)
#5 2.633 (3/10) Installing c-ares (1.33.1-r0)
#5 2.724 (4/10) Installing libunistring (1.2-r0)
#5 2.897 (5/10) Installing libidn2 (2.3.7-r0)
#5 2.991 (6/10) Installing nghttp2-libs (1.62.1-r0)
#5 3.086 (7/10) Installing libpsl (0.21.5-r1)
#5 3.174 (8/10) Installing zstd-libs (1.5.6-r2)
#5 3.291 (9/10) Installing libcurl (8.14.1-r2)
#5 3.404 (10/10) Installing curl (8.14.1-r2)
#5 3.536 OK: 13 MiB in 24 packages
#5 DONE 3.7s
```

The good pattern is also faster — 3.7s vs 75.1s — because it only has one layer instead of two.

## docker save and layer tarballs

When you save an image with `docker save`, you get a tarball containing the layers, the config, and a manifest. Let me save the image and look inside:

```bash
$ docker save layerdemo:1.0 -o layerdemo.tar
$ tar -tf layerdemo.tar
blobs/
blobs/sha256/
blobs/sha256/0a7b9a4bc63fd1d622ecd987daffa9d4b4a6eb89f62300a5bdc7d3e95188d57a
blobs/sha256/25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471
blobs/sha256/295ba08d54c41bf5b2044e3b768dd31ca4a80e9b2b7ff2583f0d7a8c0d891fbe
blobs/sha256/44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
blobs/sha256/4f0e48994f944df6fa91399f5b8e9991154d0708da055ffbae4142c8b6b4ca14
blobs/sha256/5da614f4ff00d3b0f8cc63f87287a7101f3f6b314c21998b3bb4d64e396d44f2
blobs/sha256/607546c4c2b137ab9a3b55fde920524631254e2d20087b109aeba194076e2734
blobs/sha256/7d8a5cda0a0bac9c4e32c7456caaf800f714a019c3b5675d78af3af2b200fc00
blobs/sha256/bb567b26d20069c7a83b69f7d738ed78b061520aa0b079a7a5560276ef28192d
blobs/sha256/ffae3594a09779c9cde72982cdf2c63f9d22786b6f3477bca4f4202328e6dfbf
index.json
manifest.json
oci-layout
```

The `blobs/sha256/` directory contains the actual layer tarballs and the config. The `manifest.json` maps them together:

```json
[
    {
        "Config": "blobs/sha256/ffae3594a09779c9cde72982cdf2c63f9d22786b6f3477bca4f4202328e6dfbf",
        "RepoTags": [
            "layerdemo:1.0"
        ],
        "Layers": [
            "blobs/sha256/25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471",
            "blobs/sha256/bb567b26d20069c7a83b69f7d738ed78b061520aa0b079a7a5560276ef28192d",
            "blobs/sha256/0a7b9a4bc63fd1d622ecd987daffa9d4b4a6eb89f62300a5bdc7d3e95188d57a",
            "blobs/sha256/607546c4c2b137ab9a3b55fde920524631254e2d20087b109aeba194076e2734"
        ]
    }
]
```

The `Config` is the image config JSON. The `Layers` are the layer tarballs in order. Each layer tarball contains the filesystem diff for that layer.

## Practical rules

Based on everything above, here are the practical rules for working with container image layers:

1. **Order instructions from least- to most-changing.** Stable instructions at the top, volatile ones at the bottom. This maximizes cache reuse.

2. **Pin digests in production.** Use `image@sha256:...` instead of `image:tag` to ensure you always get the exact image you expect.

3. **Keep layers small.** Each layer adds to the final image size. Clean up temporary files in the same `RUN` instruction that creates them.

4. **Combine related commands.** `apt-get update && apt-get install` in one `RUN` avoids the stale cache trap and reduces layer count.

5. **Use multi-stage builds.** Build in one stage, copy only the artifacts to the final stage. This keeps the final image small.

6. **Inspect before pushing.** Use `docker history` and `docker inspect` to understand what's in your image before you push it to a registry.

## Conclusion

A container image is not a black box. It's an ordered stack of filesystem layers, each content-addressed by a digest, tied together by a config. Understanding this structure helps you build smaller images, debug build failures faster, and make better decisions about caching and pinning. The next time you run `docker build`, remember: every instruction is a layer, every layer has a digest, and the order matters.
