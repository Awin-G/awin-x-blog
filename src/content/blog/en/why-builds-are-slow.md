---
title: "Why your build is slow: a checklist for build performance and CI speed"
description: "A slow build is rarely the compiler's fault. A checklist for measuring cold vs warm builds, finding the real culprits — reinstalling dependencies, no build cache, giant images, single-threaded steps — and fixing them with caching, incremental builds, and a shorter critical path."
pubDate: 2026-11-20
lang: en
translationKey: why-builds-are-slow
tags: [devops, linux]
featured: false
keywords:
  - slow build
  - build performance
  - build cache
  - CI speed
  - incremental build
---

Every slow build I have fixed started the same way: somebody had a theory. "It's
webpack." "It's the Docker pull." "It's the CI box, it's always the CI box." Then
we actually timed it, and the theory was wrong. A **slow build** is almost never
one thing you can guess — it is a stack of small taxes, and **build performance**
work is mostly accounting. So this is a checklist, not a rant: measure first, fix
the big rocks, and stop before you are optimising something nobody waits for.

## Why build performance is a measurement problem

A build is a pipeline, not a single command. Typical shape:

```text
install deps → typecheck → compile/bundle → package image → push → publish
```

Wall-clock time of the whole thing is not the sum of the steps; it is the sum
*plus* whatever sits on the **critical path** — the longest dependent chain. A
10-minute step that runs beside everything else costs 10 minutes once. A
2-minute step that blocks three others costs you 6. This is why "just cache it"
does not always help, and why the first honest question is never *how do I speed
this up* but *where does the time actually go*.

### Cold vs warm: report both numbers

A **cold build** has nothing cached: fresh clone, empty module cache, no Docker
layers. A **warm build** reuses local state. The two can differ by an order of
magnitude, and conflating them is how people argue past each other.

- Your laptop is usually warm. Your CI is cold by default — unless you cache.
- "The build takes 4 minutes" means nothing without saying which one.
- The gap between warm and cold is exactly the value of your **build cache**. It
  is also your measurement of how much caching would buy you.

## Measure first: where the wall-clock time actually goes

Do not reach for a profiler until you have per-step wall-clock numbers. A
`time`-per-step loop is usually enough:

```bash
#!/usr/bin/env bash
# measure-build.sh — wall-clock per step, slowest first at the end.
set -euo pipefail

step() {                       # step NAME CMD...
  local name="$1"; shift
  local t0=$(date +%s.%N)
  "$@" >/dev/null 2>&1
  printf '%.1fs\t%s\n' \
    "$(echo "$(date +%s.%N) - $t0" | bc)" "$name"
}

{ step "install deps" npm ci
  step "typecheck"    npm run typecheck
  step "bundle"       npm run build
  step "docker image" docker build -q -t app .
} | sort -rn
```

Run it twice: once on a clean checkout (cold) and once with the caches warm.
The diff is your budget. When a step dominates, drill in with the tool's own
profiler — `cargo build --timings`, `docker build --progress=plain`, webpack's
`--profile`, or just `hyperfine` around a subcommand. For the deploy side of
the pipeline, the same discipline applies as in
[zero-downtime deploys](/posts/zero-downtime-deploys/): measure the step that
gates the release, not the one that looks busy.

## The usual culprits

In rough order of how often they bite:

1. **Reinstalling dependencies every run.** `npm ci`, `pip install -r`,
   `go mod download` against a cold cache — the same bytes, fetched again.
2. **No caching at all.** No layer cache, no dependency cache, no compiler
   cache, no test-result cache. The build redoes work it already did.
3. **One giant container image.** A 2 GB base that takes 90 seconds to pull
   before your code even starts.
4. **Everything single-threaded.** A bundler, linter, or test runner that uses
   one core on a 16-core machine.
5. **Dev builds in CI.** Unminified output, source maps nobody reads, watch
   mode's overhead, debug assertions left on.
6. **Unnecessary steps.** A full test suite on a docs-only change; rebuilding
   every package when one changed.
7. **I/O-bound asset and image processing.** Resizing, minifying, or transcoding
   thousands of files, one at a time, on a slow disk.
8. **Network fetches on the critical path.** Pulling base images, toolchains, or
   registries synchronously, every single build.

Most of these are not "the compiler". They are plumbing.

## The fixes: build cache, incremental build, and the critical path

Work top-down. Fix the dominant step; ignore the 3-second ones until the 3-minute
one is gone.

### Cache layers with keys you trust

A **build cache** is only as good as its key. Key on the inputs that actually
change — a lockfile hash, a source hash, a compiler version — and never on
`latest`:

```dockerfile
# Deps change rarely; source changes constantly. Order them so the expensive
# layer survives routine edits.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build
```

Now editing one source file invalidates only the last layer. Add a
`cache-from`/`cache-to` pair in CI so an ephemeral runner inherits layers from
the previous build instead of starting from zero. Never re-download what the
cache already holds.

### Make it incremental

An **incremental build** recomputes only what changed. This is where caching
pays off: `tsc --incremental`, `cargo`'s target dir, Vite's dep cache, Gradle's
up-to-date checks, Bazel/Turborepo/Nx content hashing. The catch is honest inputs
— if your cache key ignores an env var the compiler reads, you get a fast build
that is wrong. Coordinate invalidation deliberately; do not let it surprise you.
I keep the version control side of this boring on purpose, which is the whole
argument in [git workflows for a solo developer](/posts/git-for-solo-developers/).

### Shorten the critical path

- **Parallelise** independent steps: lint, typecheck, and tests can run at once,
  and most bundlers accept a thread count.
- **Move work off the path**: fetch images in the background, warm caches in a
  scheduled job, prebuild base images on a timer.
- **Cut the dependency graph**: fewer packages is a permanent speedup, not a
  one-time trick. Removing one heavy transitive dep can save more than any flag.
- **Get faster I/O**: build on local NVMe, not a networked volume. Shuffling tens
  of thousands of small files over NFS is often the real bottleneck behind a
  "slow compiler".
- **Skip what did not change**: path filters, affected-package detection, and
  `[skip ci]`-style guards stop burns you never needed to pay.

## Before and after: one build, four numbers

A real CI job I trimmed. Same commit, same runner, only the plumbing changed:

```text
BEFORE (cold)                       AFTER (warm cache)
  install deps   214s                 install deps    27s
  lint+typecheck  38s                 lint+typecheck  38s
  bundle         142s                 bundle          46s
  docker image   189s                 docker image    34s
  push image      47s                 push image      12s
  publish         61s                 publish          9s
  ----------------------------------  ----------------------------------
  total          691s                 total          166s
```

691 seconds down to 166 — about 4×, and the biggest wins were dumb: cache the
dependency step, order the Docker layers, use a smaller base, let the bundler use
all the cores. Nothing clever. The rest is queued work on the critical path.

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="Two build timelines. Before, one long critical path dominates. After, cached steps shrink and independent work overlaps.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="0" y="16" opacity="0.7">BEFORE — 691s, one long path</text>
    <rect x="0" y="26" width="530" height="16" rx="2" fill="currentColor" opacity="0.85"/>
    <text x="538" y="39" opacity="0.75">install deps</text>
    <rect x="0" y="48" width="94" height="16" rx="2" fill="currentColor" opacity="0.55"/>
    <text x="102" y="61" opacity="0.75">bundle</text>
    <rect x="0" y="70" width="128" height="16" rx="2" fill="currentColor" opacity="0.7"/>
    <text x="136" y="83" opacity="0.75">docker image</text>
    <text x="0" y="118" opacity="0.7">AFTER — 166s, cached + overlapped</text>
    <rect x="0" y="128" width="30" height="16" rx="2" fill="currentColor" opacity="0.85"/>
    <text x="38" y="141" opacity="0.75">deps (cached)</text>
    <rect x="0" y="150" width="30" height="16" rx="2" fill="currentColor" opacity="0.55"/>
    <rect x="0" y="172" width="34" height="16" rx="2" fill="currentColor" opacity="0.7"/>
    <line x1="30" y1="126" x2="30" y2="192" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
    <text x="42" y="163" opacity="0.75">bundle + image, parallel</text>
    <text x="0" y="222" font-family="ui-monospace, monospace" font-size="11" opacity="0.5">← each box is wall-clock time; widths are relative within each block →</text>
  </g>
</svg>
<figcaption>Same work, two shapes. Caching shrinks the boxes; parallelising and a smaller base keep the remaining work off the <code>critical path</code>.</figcaption>
</figure>

## CI speed: the parts that are not your compiler

**CI speed** is a separate problem from local build speed, and it fails in its
own ways. Ephemeral runners are always cold, so caching must be configured
explicitly, and every cache upload and download costs wall-clock too. Concurrency
limits mean your job queues behind others. And a runner that is throttled to one
vCPU will make parallel build flags pointless. When a build is fast on your
laptop and slow in CI, the difference is almost always cache state, core count,
or disk — check those three before you touch the config.

## The trap: over-optimising a build nobody waits for

The goal is not the fastest build. The goal is a build nobody notices. A release
pipeline that runs nightly and never blocks a human is done; shaving it from nine
minutes to eight buys nothing. Optimise the builds that sit on the **critical
path** of a person — the ones you run between an edit and a test, the ones that
gate a deploy. Touch a file and wait 40 seconds in CI? That is worth work. A
weekly job you start and walk away from? Let it be slow.

So the checklist ends where it began: **measure, find the dominant step, cache
it, incrementalise it, parallelise what remains — and then stop.** The best build
performance is the build you stopped caring about because it never made you wait.
