---
title: "Core Web Vitals in practice: LCP, CLS, and INP without guessing"
description: "No guessing, no vibes: I ship two fixture article pages, one sloppy and one fixed, and paste the real Lighthouse and web-vitals output. What actually moves LCP, CLS and INP on a mostly-static site, and which micro-optimizations are not worth your time."
pubDate: 2027-01-18
lang: en
translationKey: core-web-vitals
tags: [seo, astro]
featured: false
keywords:
  - Core Web Vitals
  - LCP
  - CLS
  - INP
  - Lighthouse
---

I do not trust the phrase "feels fast", so this article is the alternative:
two fixture article pages — same text, same photo, one shipped the way sites
accidentally ship it and one shipped the way they should — measured with real
tools, output pasted below. **Core Web Vitals** (LCP, CLS, INP) are three
numbers you can either measure or argue about, and I would rather measure.
Here is what each metric is actually made of, and the honest list of fixes
worth your evening.

## The three metrics, the thresholds, and who scores you

| Metric | Good | Needs work | Poor | What it is |
|---|---|---|---|---|
| **LCP** (Largest Contentful Paint) | < 2.5 s | 2.5–4 s | > 4 s | Time until the largest element in the viewport paints |
| **CLS** (Cumulative Layout Shift) | < 0.1 | 0.1–0.25 | > 0.25 | Sum of unexpected layout shifts during the visit |
| **INP** (Interaction to Next Paint) | < 200 ms | 200–500 ms | > 500 ms | Worst interaction latency across the whole visit |

The part nobody explains is *who scores you*. **Field data** comes from CrUX,
the Chrome User Experience Report: real Chrome users, the 75th percentile,
28 days. That number feeds ranking. **Lab data** is one Lighthouse run — a
throttled, simulated, single visit. PageSpeed Insights shows both, which is
the only honest way to read a report: a green lab score with a red field score
means your users' devices are nothing like the lab. Two consequences: INP is
field-first, and a lab run without an interaction can't really score it —
Total Blocking Time (TBT) is the proxy, and I'll show below how badly the
proxy can lie. Also, simulated throttling makes lab numbers boring: three runs
per fixture, and the unoptimized one was byte-identical every time while the
optimized one wobbled by a few hundred milliseconds.

## LCP: four clocks, and three of them are yours

An LCP measurement is a little waterfall with four segments:

1. **TTFB** — first byte of the HTML. Server, CDN, TLS.
2. **Resource load delay** — from first byte to the browser *starting* the
   LCP download. Where lazy-loading your hero image lives.
3. **Resource load duration** — the bytes on the wire. Image size, format.
4. **Element render delay** — bytes arrived to pixels painted. Main-thread
   contention, render-blocking CSS, fonts.

Lighthouse breaks the optimized fixture's LCP into exactly these parts
(`lcp-breakdown-insight` from the JSON report):

```json
{"subpart":"timeToFirstByte","label":"Time to first byte","duration":4.325},
{"subpart":"resourceLoadDelay","label":"Resource load delay","duration":15.877},
{"subpart":"resourceLoadDuration","label":"Resource load duration","duration":4.531},
{"subpart":"elementRenderDelay","label":"Element render delay","duration":36.247}
```

The LCP element is `body > main.wrap > picture > img.hero` — a 24.8 KB AVIF in
a `<picture>`, with real `width`/`height` and `fetchpriority="high"`. Every
segment is tiny because I made every segment tiny.

The unoptimized fixture serves the same photo as a 2.27 MB PNG, plus an 880 KB
unsubset TTF with `font-display: swap`, plus 53 KB of CSS and a 52 KB "tag
manager", both render-blocking in the head. Its measured LCP is **8.8 s**, and
Lighthouse names the suspects itself:

```
render-blocking-resources   Est savings of 4,990 ms | analytics.js 901ms ; app.css 751ms
uses-responsive-images      Est savings of 1,898 KiB | hero-big.png 1847KB ; hero-1200.webp 51KB
lcp-lazy-loaded             hero-big.png" loading="lazy" alt="…">
unsized-images              hero-big.png, hero-1200.webp
total-byte-weight           Total size was 3,258 KiB
```

Three lessons, in order of bytes. **Bytes beat tricks**: 2.2 MB of PNG is
minutes of pain on 4G and invisible on localhost — hence a resized,
AVIF-first `<picture>`. **A lazy-loaded hero is a self-inflicted wound**:
`loading="lazy"` on the LCP element delays discovery of the one resource that
decides the score. **Render-blocking scripts are LCP tax**: a synchronous
analytics tag in the head delays first paint even when its content is useless;
`defer` it or load it after the load event.

<figure>
<svg viewBox="0 0 680 250" role="img" aria-label="LCP timeline comparison: the unoptimized fixture takes 8.8 seconds with render-blocking CSS and JS, a large font download and a 2.2 MB PNG before paint; the optimized fixture paints in 1.1 seconds." fill="none" stroke="currentColor" font-family="ui-monospace, monospace" font-size="11">
  <text x="40" y="18" fill="currentColor" stroke="none" font-size="12">unoptimized fixture — LCP 8.8 s</text>
  <rect x="40" y="28" width="547" height="34" rx="4" fill="#0f766e" fill-opacity="0.08" stroke-width="1"/>
  <rect x="40" y="28" width="3" height="34" fill="#0f766e"/>
  <rect x="43" y="28" width="102" height="34" fill="#0f766e" fill-opacity="0.75"/>
  <rect x="145" y="28" width="266" height="34" fill="#0f766e" fill-opacity="0.5"/>
  <rect x="411" y="28" width="173" height="34" fill="#0f766e" fill-opacity="0.3"/>
  <rect x="584" y="28" width="3" height="34" fill="#0f766e" fill-opacity="0.9"/>
  <text x="49" y="82" fill="currentColor" stroke="none">TTFB 4 ms</text>
  <text x="150" y="82" fill="currentColor" stroke="none">CSS + tag manager block 1.6 s</text>
  <text x="200" y="98" fill="currentColor" stroke="none">880 KB font swap-in</text>
  <text x="470" y="82" fill="#0f766e" stroke="none">hero 2.2 MB PNG</text>
  <line x1="196" y1="24" x2="196" y2="128" stroke="#0f766e" stroke-dasharray="3 3"/>
  <text x="152" y="140" fill="currentColor" stroke="none">2.5 s threshold</text>

  <text x="40" y="180" fill="currentColor" stroke="none" font-size="12">optimized fixture — LCP 1.1 s</text>
  <rect x="40" y="190" width="68" height="26" rx="4" fill="#0f766e" fill-opacity="0.08" stroke-width="1"/>
  <rect x="40" y="190" width="3" height="26" fill="#0f766e"/>
  <rect x="43" y="190" width="49" height="26" fill="#0f766e" fill-opacity="0.6"/>
  <rect x="92" y="190" width="13" height="26" fill="#0f766e" fill-opacity="0.3"/>
  <rect x="105" y="190" width="3" height="26" fill="#0f766e" fill-opacity="0.9"/>
  <text x="40" y="236" fill="currentColor" stroke="none">preloaded AVIF 25 KB · system fonts · no render-blocking JS</text>
</svg>
<figcaption>The two LCPs, roughly to scale, from the Lighthouse report: TTFB →
render-blocking → transfer → paint. Dashed line is the 2.5 s "good"
threshold. Same photo, same text; 3,258 KiB versus 105 KiB.</figcaption>
</figure>

## CLS: every pixel that moves after first paint

CLS punishes *surprise*, not slowness: it sums impact × distance for every
layout shift that happens without a recent user input. Three sources cause
almost all of it in the wild, and the fixtures carry all three on purpose.

**Images without dimensions.** Both fixture images ship with no `width` and
`height`, so the browser reserves no space and the reflow when the bytes
arrive counts. One attribute pair per image — or `aspect-ratio` in CSS — and
the shift disappears at the source.

**Injected content.** The bad fixture's tag manager inserts a cookie banner
above the article on load and an "ad slot" 300 ms later. In the Lighthouse run
the banner alone produced the only counted shift:

```
layout-shifts    score 0.0958 | <p>
```

0.096 is *technically* under the 0.1 threshold — the fixture passes CLS by
having a banner 10 px too short to fail. That's not design, that's a coin
flip. Reserve the space, or inject the banner after the user has scrolled past
the position it will occupy.

**Font swap.** The bad fixture paints with a serif fallback, then swaps in an
880 KB sans at a different width. The number here is messy, so here it is
exactly: Lighthouse's simulated run counted **CLS 0.096**, while my
unthrottled browser run measured **CLS 0.273** (poor), the largest shift being
the `h1` reflowing at 499 ms:

```json
{"name":"CLS","value":0.2725941844516331,"rating":"poor",
 "target":"html>body>main.wrap>h1","shiftTime":499.5,"shiftValue":0.1449832352532281}
```

Two lab tools disagreeing by 3× is not a bug, it's the lesson: they load
pages on different clocks, so *which* shifts land inside the viewport changes
run to run. Neither is the referee — CrUX is. The fix is the same either way:
a system font stack (what the optimized fixture uses), or one subset `woff2`
with `font-display: optional` so the swap costs no shift.

## INP: the metric Lighthouse cannot see in a lab

INP is the latency of the worst interaction a user has with your page, input
to next painted frame. Lighthouse approximates it with TBT — main-thread
blocking time between FCP and TTI — and here the approximation fails
instructively: the bad fixture's startup busy loop runs *before* first paint,
outside the TBT window, so Lighthouse reports:

```
total-blocking-time   0 ms   score 1
```

Zero. Immaculate. And yet clicking the fixture's demo button — a naive
"filter" that re-scans 500,000 items on every click — measures like this in a
real browser with the `web-vitals` attribution build:

```json
{"name":"INP","value":416,"rating":"needs-improvement",
 "target":"html>body>main.wrap>div.newsletter>button",
 "inputDelay":0.4,"procDur":406.1,"presentDelay":9.5}
```

416 ms, all of it in the handler (`procDur` 406 ms): one synchronous loop, one
reflow storm. The optimized fixture precomputes an index at idle time, and its
click handler measures **INP 16 ms** in the same harness:

```json
{"name":"INP","value":16,"rating":"good",
 "target":"html>body>main.wrap>div.newsletter>button","procDur":0.3}
```

TBT catches *startup* long tasks, INP catches *interaction* long tasks, and a
green TBT says nothing about your click handlers. On a static site the fix is
rarely exotic: precompute, move work off the click path, delegate — and if a
task must exist, run it in a worker.

## How I actually measure

Lighthouse from the CLI is the workhorse. The exact run behind every number
here — a static fixture on `127.0.0.1:8099`, Lighthouse 12.8.2 with Chromium
139, mobile preset (simulated Slow 4G: 1.6 Mbps, 150 ms RTT, 4× CPU throttle),
three runs per page:

```console
$ CHROME_PATH=/ms-playwright/chromium-1181/chrome-linux/chrome \
  lighthouse http://127.0.0.1:8099/bad.html \
  --output=json --output-path=/tmp/lh-bad.json \
  --disable-full-page-screenshot \
  --only-audits="first-contentful-paint,largest-contentful-paint,cumulative-layout-shift,total-blocking-time,interactive,lcp-breakdown-insight" \
  --chrome-flags="--no-sandbox --headless=new"
LH:status Generating results...
```

Keep the JSON: the audit names (`render-blocking-resources`,
`uses-responsive-images`, `unsized-images`, `lcp-lazy-loaded`) tell you what
to fix in the order the bytes are spent. For field data I use PageSpeed
Insights in a browser and the CrUX API (or BigQuery) for history — no field
data beats three months of p75 numbers, and no lab number should be argued
with in a meeting where field data exists. For INP you own, the `web-vitals`
snippet above is 20 lines and runs in production.

And `curl -w`, because a TTFB sanity check takes ten seconds:

```console
$ curl -s -o /dev/null -w "ttfb=%{time_starttransfer}s total=%{time_total}s size=%{size_download}B\n" \
    http://127.0.0.1:8099/good.html
ttfb=0.001113s total=0.001199s size=6164B
```

Both fixtures answer in ~1 ms: the bottleneck was never the network, it was
the front end. That's the point of measuring instead of guessing — on
localhost the difference between a 58 and a 100 performance score is 100%
stuff you control.

## The fixture, before and after

Same text, same photo, one page each:

| | Unoptimized | Optimized |
|---|---|---|
| LCP | 8.8 s ❌ | 1.1 s ✅ |
| CLS | 0.096 ⚠️ | 0 ✅ |
| TBT | 0 ms | 10–120 ms across 3 runs |
| Measured INP (web-vitals) | 416 ms ❌ | 16 ms ✅ |
| FCP / TTI | 5.9 s / 9.0 s | 0.6 s / 1.1 s |
| Page weight | 3,258 KiB, 8 requests | 105 KiB, 5 requests |
| Lighthouse performance | 58 | 100 |
| Hero image | 2.27 MB PNG, lazy, no size | 24.8 KB AVIF, preloaded, sized |
| CSS | 53 KB render-blocking | 3 KB inlined |
| Third-party JS | 52 KB sync tag manager | none |

## What I do on a mostly-static site — and what I skip

The honest priorities, by bytes recovered per hour spent:

1. **Server and CDN first.** Static HTML behind a CDN with a warm edge is the
   cheapest TTFB you will ever buy; no front-end work repairs a 900 ms origin.
   It's most of why I build [static sites in 2026](/posts/static-sites-in-2026/)
   the way I do.
2. **One image pipeline.** Resize to the largest size you actually serve, AVIF
   with WebP fallback, real `width`/`height`, `fetchpriority="high"` on the
   hero, `loading="lazy"` only below the fold. Highest leverage change on
   almost every content site.
3. **Zero injected layout.** If a banner or ad must exist, reserve its box.
   CLS is the one metric that is purely a discipline problem.
4. **As little JavaScript as possible** — ideally none on the read path.
   What remains gets `defer`, delegation, and precomputation, because INP is
   measured on what you do after the user touches something.

And the micro-optimizations I've stopped doing, because I measured and they
were noise: critical-CSS tooling around a 3 KB stylesheet (just inline it);
`preconnect` to your own origin (same-origin connections are already warm);
`font-display` choreography when you ship zero webfonts; `dns-prefetch` for
domains you don't use; splitting a fixed-width column's image into four
srcset candidates instead of one right-sized file; double-compressing what
brotli already compressed. The fixture's CSS is 54,619 bytes raw and 8,880
gzipped — if your pipeline can't gzip text, fix that before you shave 50 ms of
INP with a scheduler.

One more: don't chase lab scores you cannot move. A 90 → 95 improvement is
three small wins and a lot of ceremony, while the 58 → 100 jump above came
from four structural decisions. If you want to know where builds and pages
lose their time, [why builds are slow](/posts/why-builds-are-slow/) is the
same experiment from the other end.

Measure the field, fix the top offender, ship. That's the whole method.
