# AGENTS.md — durable project memory

> **Purpose.** This file is the long-term memory for whoever/whatever works on this
> blog (human or agent). Context gets compressed and details get lost; this file is
> the thing that survives. **Keep it current — update it in the same commit as any
> change to pipeline, deploy, design system, or conventions.**
>
> Last updated: 2026-10-15 (a long build-out day: five interactive pieces + a systemd
> hardening generator + a `/labs/` hub; two site-wide layout bugs found by measurement and
> fixed (mobile horizontal scroll, hero misalignment); interactive pieces made
> no-JS-crawlable, keyboard-accessible and dark-mode-verified; internal linking fixed
> (tool pages 2 → 28–178 inbound links, zero orphans); the ad path found broken and wired;
> the Open Ledger defect log extended 5 → 9 entries; full-site health, secret, dependency
> and analytics-pipeline audits all clean. Operator actions live in `留言.md`; the first
> goal is still to cover ~¥160/yr — see §15.)

---

## 1. What this is

A **static, bilingual (EN/ZH), SEO-first blog** at **https://blog.awin-x.top**
("DeepSeek @ awin-x"), self-hosted on the user's own server. Written first-person by
"DeepSeek", an AI engineer. **Traffic is the whole point.** Content is produced in
batches by parallel subagents and every article is grounded in a *reproduced
experiment* (real Docker/commands, real output).

- EN is the default locale at `/`; ZH lives at `/zh/`.
- No web fonts (system stack only). Fast, static, hand-written CSS.
- 0–3 figures per article; **SVG-first**, but real raster figures are allowed when
  the subject is genuinely visual (e.g. the DotLens3D renders).

---

## 2. Golden rules (do not break the pipeline)

1. **Every article ships in BOTH languages** with a matching `translationKey`, or the
   content gate fails the build.
2. **Real output only.** Every command/output block must have actually been run. If it
   couldn't be run, either label it explicitly as illustrative *in the article*, or omit
   it. Never invent ports, timings, errors. (This was violated once — a fabricated
   `127.0.0.1:xxxxx` in `tcp-proxy-in-go` — and had to be repaired.)
3. **Validate before shipping**: `npm run check:content` → `npm run build` → commit →
   push to **both** remotes → deploy.
4. **Don't retrofit old articles.** Changes apply to new work (or to a deliberate,
   called-out fix like the fabricated-output repair).
5. **Don't prune Docker images** on the dev box; preserve the user's named volumes.
6. **Ask few questions.** Prefer autonomous exploration; the operator has asked for
   fewer interruptions and long-horizon self-direction.
7. **Subagents write only their two article files** — never `AGENTS.md`, `留言.md`,
   scripts, or any other repo file.

---

## 3. Repo layout (the blog)

```
src/
  content/blog/{en,zh}/*.md     # 1 file per article per language
  layouts/{BaseLayout,PostLayout}.astro
  components/                   # Header, Footer, PostCard, HomeView, tools/*, …
  components/{SupportView,UsesView,SearchView,AdSlot}.astro  # monetisation + search
  pages/                        # routes: /, /posts, /tags, /tools, /about, /start,
                                #   /uses, /support, /search, 404 (each mirrored in /zh/)
  styles/global.css             # base theme (954 lines)
  styles/theme.css              # "engineering notebook" override layer (see §9)
  lib/{posts,tags}.ts           # post helpers, tag descriptions
scripts/
  check-content.mjs             # THE content gate (runs in `prebuild`)
  content-index.mjs             # content index + dedup/related CLI (npm: index/find/dupes)
  lib/similarity.mjs            # shared tokenizer + cosine (gate + index)
  og.mjs                        # OG card generator (incremental, manifest-cached)
  crosspost.mjs                 # dev.to drafts → crosspost/devto/
  deploy.sh                     # TOWER-side: pull → npm ci → build → atomic publish
  indexnow.sh                   # IndexNow submission
deploy/
  run-deploy.sh                 # TOWER entrypoint (takes lock, fast-forwards repo)
  nginx-blog.conf               # blog vhost
  analytics-report.sh + blog-analytics.service
  tools/dnspod_set.py           # DNS automation (Tencent DNSPod)
notes/                          # strategy, workflow brief, HN queue, distribution kits
```

---

## 4. Content model & conventions

Frontmatter (exact fields; no extras):

```yaml
title: "<EN ≤120 chars>"        # seoTitle optional
description: "<20–320 chars>"   # THE gate is strict here
pubDate: 2027-01-23             # dates run into the future on purpose (queue)
lang: en|zh
translationKey: <slug>          # must pair across en/zh
tags: [<lowercase ASCII>]       # see allowed list below
featured: false
keywords: [ ... ]
```

- **Allowed tags**: `esp32, networking, embedded, c, rust, easytier, self-hosting,
  python, reverse-engineering, security, ai, agents, homelab, nginx, devops, systemd,
  linux, seo, astro, meta`.
- **Descriptions 20–320 chars** — the single most common gate failure; subagents
  overshoot, so trim in the brief.
- Post slug = filename. Check it doesn't collide (`ls src/content/blog/en`).
- Internal links must point at existing slugs; the gate rejects broken links.
  Useful known-good targets: `/posts/reading-a-codebase/`, `/posts/local-first-software/`,
  `/posts/linux-load-average/`, `/posts/nginx-cookbook/`, `/posts/systemd-unit-cookbook/`,
  `/posts/container-security/`, `/posts/sqlite-is-enough/`, `/posts/prometheus-in-practice/`, …
- ZH pages are faithful translations of EN (same figures, same code blocks).

---

## 5. The content gate (`scripts/check-content.mjs`, runs in `prebuild`)

Checks: frontmatter schema · description length 20–320 · title ≤120 · `translationKey`
pairing (every EN has a ZH and vice-versa) · broken internal links · duplicate titles ·
**near-duplicate topics** (weighted cosine ≥ 0.78 → fail, ≥ 0.68 → warn; via
`scripts/lib/similarity.mjs`). **Bad content cannot ship** — the build fails. Run
`npm run check:content` alone for a fast check.

---

## 6. The content pipeline (how articles get made)

- **First, consult the index** — `npm run index` (rebuild), `npm run find -- "…"`
  (closest existing posts + similarity score), `npm run dupes` (corpus redundancy).
  Drop candidates ≥ ~55% similar to an existing post; harvest real related slugs for
  internal links. The human-readable index is `notes/content-index.md`. Rebuild the
  index after each batch so the next one sees the new posts.
- Work in **batches of 6 topics**; each topic = 1 article in 2 languages = 2 files.
- Drafting is done by **parallel background subagents** (`general` agent).
- **Models**: use the free ids, rotating — **`opencode-go/longcat-2.5-preview-free`**,
  **`opencode-go/step-5-preview-free`**, and other `*-free` ids. **Never** use the host
  `ollama`.
- Subagent brief lives in `notes/content-workflow.md`. Each brief specifies: workspace
  `/tmp/opencode/work/<slug>/`, Docker encouraged (**no sudo, no `--privileged`, no host
  installs, write only in the scratch dir, touch no repo files except the two outputs**),
  the topic outline, primary/secondary keywords, internal links, visual guidance, SEO
  length, and the exact frontmatter.
- Subagents may fail silently (no files, no summary). **Verify the two files exist**;
  if not, re-launch on a different free model.
- One free endpoint failing mid-request ("Endpoint is unavailable") is normal — retry
  on another free model.
- After a batch: gate → build → commit → push both remotes → `npm run crosspost` →
  deploy. Then verify live (200s + counts).

---

## 7. Deploy pipeline (TOWER)

- **Remotes**: `origin` = `git@git.awin-x.top:awinx/blog.git` (Gitea),
  `github` = `git@github.com:Awin-G/awin-x-blog.git`. **Push to both.**
- **TOWER**: `ssh -p622 root@88.218.79.95` (hostname `mail.awin-x.top`).
  - repo `/srv/blog/repo`; releases `/srv/blog/releases/<ts>-<sha>`; webroot
    `/var/www/blog` → symlink to `/srv/blog/current`; state `/srv/blog/state/last-built`.
  - entrypoint `/srv/blog/deploy.sh` (= `deploy/run-deploy.sh`): takes the lock, fetches,
    then runs `repo/scripts/deploy.sh`.
  - Driven by **`blog-deploy.timer`** (~every 3 min). Manual: `FORCE=1 /srv/blog/deploy.sh`.
  - Publish is atomic (build into a release dir, symlink swap). Keeps 4 releases.
  - IndexNow runs on every deploy.
- **Memory**: TOWER has only **981 MB RAM**. A **2 GB `/swapfile`** was added (persisted
  in `/etc/fstab`) because the Astro build now peaks ~790 MB and the kernel was OOM-killing
  `node` mid-build (exit 137). If builds get heavier again, watch `free -m` /
  `journalctl -k | grep -i oom`.
  - **Status check (2026-10-15)**: all four `Out of memory: Killed process … (node)` events
    are dated **Oct 13**, i.e. *before* the swapfile; every build since has completed
    (`blog-deploy.service` logs page output normally). Disk 72% used, 3.7 GB free.
  - **Minor inefficiency, left alone deliberately**: `swapon --show` reveals two swaps —
    `/dev/vda2` (512 MB, prio **-2**) and `/swapfile` (2 GB, prio **-3**). The kernel
    therefore fills the *small* partition first and only spills into the big file. It works
    (the fallback is automatic), so this was not changed on the operator's box; giving the
    swapfile a higher priority would be the tidy fix if builds ever get tight again.
- **OG cards are incremental**: `scripts/og.mjs` keeps `public/og/.manifest.json`
  (slug→hash) and only re-renders changed cards. `public/og/` is gitignored so it
  survives the deploy's `git clean`. Don't revert this to "wipe + render all 400".

---

## 8. Hosts, DNS, analytics

- **DNS**: Tencent DNSPod, automated via `deploy/tools/dnspod_set.py`. Apex `awin-x.top`
  → **`88.218.79.95`** (changed 2026-10-15 so Google AdSense can verify the root domain;
  it used to point at the EasyTier overlay IP `10.126.126.1`). `www`/`blog`/`mail`/`vw`/
  `nps`/`captcha` → `88.218.79.95`; `git`/`alist`/`s3` stay on the overlay `10.126.126.1`.
  - The apex has its own nginx vhost (`deploy/nginx-apex.conf`, installed by hand): it
    serves `/ads.txt` + `/robots.txt` + the ACME challenge, and **301s everything else to
    `https://blog.awin-x.top/`**. TLS reuses the pre-existing
    `/etc/nginx/cert/awin-x.top.pem` (the box's own SSL automation, not certbot).
- **Analytics**: server-side **GoAccess** over nginx logs at
  **https://stats.awin-x.top/** (basic auth; credentials are in the deploy scripts —
  **not** duplicated here because this repo is mirrored to GitHub).
  - GoAccess 1.3 needs `$HOME` set (silent-failure fix) and **ignores `TZ`**, so logs are
    converted to **China time (+0800)** before parsing. No `--ignore-crawlers`.
  - Use this data to steer topics and (over months) the design (§9).
  - **Trend data for the observation window**: `blog-analytics-snapshot.timer` runs
    `deploy/analytics-snapshot.sh` daily on TOWER, appending one line per day to
    `/var/www/stats/history.tsv` (date, requests, visitors, files, bandwidth, top pages,
    referrers, **crawler breakdown**, **top articles by distinct IP**, **browser-IP count**).
    The live report only shows the current window, so this file is what a multi-week review
    is read from.
    The last three columns were added 2026-10-15/17 because they are what the December
    decision actually needs. Two measurement lessons went into them:
    - **Hit counts lie.** 551 requests came from a single spoofed 2015 Firefox UA, so the
      article column now ranks by **distinct client IPs**, not hits.
    - **The orchestrator pollutes its own data.** ~674 requests were my own `curl`
      verifications, so CLI user agents are excluded from the human-ish buckets.
    The script (`deploy/analytics-snapshot.sh`) is installed at `/srv/blog/analytics-snapshot.sh`
    — **copy it there after changing the repo version**, since the systemd unit runs the
    installed copy, not the repo one (and the repo checkout only updates when a deploy runs;
    I got this wrong twice).
  - **Verified working (2026-10-15/16)**: the timer is scheduled (00:00 BST daily) and the
    service was exercised **through systemd** (`systemctl start …` → `Result=success`,
    exit 0) with the enriched 9-column output, and it is idempotent (re-running replaces
    that day's line). This file is the *only* record of the observation window — if it
    stops growing, the December review has nothing to read, so check it whenever the window
    is discussed.
  - **First readings (2026-10-14/15)**: ~2.4–2.9k requests/day but only **10–59 visitors**,
    and most of it is bot noise (349 unique 404s, all `/wp-admin` / `*.php` scans).
    Per-UA breakdown of **`/var/log/nginx/blog.access.log`** (the *blog* vhost logs here,
    **not** to `/var/log/nginx/access.log` — grepping the wrong file yields all zeros):
    GoogleOther 990, Googlebot 504, bingbot 84, AhrefsBot 74, YandexBot 4,
    **Baiduspider 0**. So **Google crawls heavily but does not rank yet** (GSC verify is the
    lever) and **Baidu has never crawled at all**. An earlier note in this file claimed the
    `ziyuan.baidu.com` referrers meant "Baidu is the channel with a pulse" — that was wrong
    (it was not crawl traffic) and has been corrected in `留言.md`. Human visits: a handful.
  - **Trend, 2026-10-14 → 27** (from the enriched columns): requests 2918 → 3826 → 4550 →
    4342; GoAccess "visitors" 59 → 119 → 160 → 274; **browser-shaped distinct IPs 238** on
    the 17th. So traffic *is* drifting up, but slowly and mostly from crawlers.
    - **Googlebot/GoogleOther fell off sharply after the 15th** (1526 → 96 → 44) — that
      burst was a crawl, not a habit. bingbot is steady (~43–142/day).
    - **Baiduspider appeared on 2026-10-17 and again on 10-21..23** (2, then 14/52/24) —
      it does crawl occasionally after all. Still negligible; the operator has written
      Baidu off, so treat it as noise unless it grows.
    - **The interactive pieces were the top articles by distinct IP** on the 17th
      (`bead-lens-lab(7)`, `request-ladder(6)`, `wire-protocol-bytes(6)`) — the first
      evidence the "different in kind" work is what distinct clients fetch.
  - **THE BIG CORRECTION (2026-10-27)**: on 10-21..27 the numbers exploded — visitors
    453 → 490 → **965** → **1289**, browser-IPs up to ~700. It was **not** growth. It was a
    **distributed scraper**: five different browser UAs each spread over 30–84 IPs with
    **exactly one request per IP** (proxy pool, so no per-IP rate limit ever trips). The
    honest numbers: Google search referrers ~51 requests over five days, **external
    (non-self) referrers only 36**, and the top *articles* by distinct IP are 2–4 each.
    Baidu 0, no real audience.
    - The snapshot now detects this: UAs with `≥20 IPs` and `<1.5 requests/IP` are counted
      as `scraped=` and excluded from the human buckets. Re-running 10-27 gave
      `scraped=532`, browser-IPs **255** (was ~700), and top articles of
      `docker-compose-cookbook(4), sqlite-json1-and-generated-columns(3), graceful-shutdown(2)`.
    - **Lesson**: distinct-IP is *not* a human proxy on its own — a proxy pool defeats it.
      The ratio of requests-per-IP (≈1.00 across many IPs for one UA) is the tell.
    - The scrapers *targeted* `wireguard-vs-openvpn`, `quic-and-http3` and
      `best-self-hosted-apps-2026` — i.e. the high-search-volume comparison/roundup
      posts. That is at least a hint about which topics have demand.
- **Verification files** live: Google (DNS TXT), Bing (`BingSiteAuth.xml`),
  Baidu (`baidu_verify_codeva-...html`).
- **Indexing**: Google crawls + reads the sitemap but hasn't indexed yet; GSC "Verify"
  by the operator is the outstanding action. IndexNow is submitted on every deploy.
- **Baidu is a dead end for this domain (operator, 2026-10-15)** — do not invest here.
  Two reasons: the 百度搜索资源平台 shows a **sitemap submission quota of 0**, and Baidu's
  database still associates `awin-x.top` with the operator's **earlier, deleted Hexo site**
  ("佳法运算") which published reverse-engineered IP-camera firmware and root-login
  vulnerabilities. Baiduspider has never crawled the new blog (0 hits in the vhost log).
  Context worth keeping: the operator's own background is IoT/camera firmware
  reverse-engineering, which lines up with the ESP32/embedded/reverse-engineering side of
  the blog.

---

## 9. Design system ("engineering notebook")

Direction chosen by the operator: **engineering notebook / terminal craft** —
technical, distinctive, readable, fast. Long-horizon policy (operator's words): the
*"long time"* for design evolution means **a quarter to a year**, not days; different
pages may trial different variants and the design converges toward whatever performs
best. Prefer a **system that can evolve** (tokens + components) over one-off styling.

- **`src/styles/theme.css`** is an additive override layer loaded after `global.css`.
  Keep new visual work there (reversible, low-risk) rather than editing the 954-line
  base file.
- **Tokens**: warm "graph paper" light (`--bg #f7f6f2`) and green-black dark
  (`--bg #0f1513`); brand accent **teal** `#0f766e` (dark `#2dd4bf`); a second
  annotation ink `--mark` (amber) used *only* for `FIG.` labels / warnings.
- **Signature motifs** (keep to a few): mono eyebrow + hairline rule on post headers;
  mono metadata/labels/tags (never mono prose); code blocks with a language chip + copy
  button; heading anchors; reading-progress bar; active-section TOC.
- **No web fonts. No heavy JS. No layout-shifting copy buttons.** Prefer
  `transform: scaleX()` for progress, CSS counters for figure numbers, build-time syntax
  highlighting (Shiki).
- Inspiration research (real sites + tricks) was gathered from jvns.ca, ciechanow.ski,
  xeiaso.net, Vellum theme, x51.dev terminal, Stripe docs, Tailscale, simonwillison.net.
- **Visual verification loop**: no screenshot tool in the harness, but headless
  Playwright/Chromium **in Docker** works, and vision-capable subagents
  (e.g. `opencode-go/deepseek-v4-flash-vision-exp`) can *read* images. Use
  render/screenshot → vision review when changing visuals.

---

## 10. Gotchas / lessons learned

- **Astro build OOM on TOWER** → fixed by swap (see §7). Build ~1.5 min on 1 core.
- **Shiki language warnings** are harmless: `[Shiki] The language "X" doesn't exist,
  falling back to "plaintext"` (e.g. `sshconfig`, `caddyfile`, `nft`, `dns`). Not errors.
- **Descriptions >320 chars** fail the gate — trim in the brief, not after.
- **OG images**: `/og/<lang>/<slug>.png`; `og.mjs` is incremental; a first run after a
  cache wipe re-renders everything once.
- **Fabricated output** is the one unforgivable content sin; see Golden rule 2.
- **Dedup has two layers.** `npm run find` checks *your* proposed wording; the gate
  checks the *final* article's title/description/keywords. A subagent can therefore
  land a legitimate-looking follow-up at 70–77% similarity (e.g.
  `container-seccomp-hardening` vs `container-security` = 73%) — a warning, not a
  failure. For a deliberate deep-dive, differentiate the title/keywords so the corpus
  stays clean.
- **GoAccess**: needs `$HOME`; ignores `TZ` (hence +0800 conversion).
- **Docker on the dev box**: works unprivileged; official images preferred.
- **Security demos must be harmless** — print-only payloads, never a real
  destructive command, even in a scratch dir (one subagent's `shell=True` demo
  actually ran an `rm -rf` and deleted its own scratch repo).
- **`/tmp` is a 5.8 GB tmpfs and it fills up.** `/tmp/opencode/work/*` accumulates one
  scratch dir per article/experiment and is never auto-cleaned; when it hits the quota,
  file writes fail silently mid-screenshot and produce blank/garbage PNGs. Sweep old
  scratch dirs before long work (`rm -rf` everything but the current session's dirs).
  Some Docker-created dirs are root-owned and need the container user to remove.
- **`--window-size` cannot go below 500px in headless Chromium.** Asking for
  `--window-size=390,1000` still lays the page out at **500px**; the screenshot is then
  cropped to 390, so content looks "clipped at the right edge" and you will chase a
  phantom mobile-overflow bug (this happened, and a vision subagent confirmed the phantom
  at length). For a true narrow viewport render the page in
  `<iframe width="390" scrolling="no">` and measure/screenshot that. Decide layout
  questions with `documentElement.scrollWidth` vs `innerWidth` (and Range rects for text
  extents) inside that iframe — never with pixel inference alone. Injecting a probe script
  into a copy of the built page also works for the direct context.
- **Testing dark mode: use `--force-dark-mode`, not variable injection.** The site's dark
  theme is driven entirely by `@media (prefers-color-scheme: dark)` (the `[data-theme]`
  attribute is only *excluded* from, never applied). Injecting the dark custom properties
  into an iframe therefore renders dark *variables* but silently skips every
  media-conditional rule — a trap I fell into. `--force-dark-mode` makes
  `matchMedia('(prefers-color-scheme: dark)')` genuinely match (verified), so it is the
  correct harness. Measured result: the interactive components are fine in dark mode —
  region tints are ΔE ≥ 11.5 apart (JND ≈ 2.3) and hex digits sit at 7.8–13.8:1 contrast.
- **Vision**: this agent is text-only; use the `vision` skill / vision subagents to read
  images (per the injected vision note, the chosen model is `deepseek/deepseek-flash`).

---

## 11. Current state

- **265 articles / 530 posts / 615 pages / 614 sitemap URLs** (the 260-article mass phase
  ended at batch 45; the 261st is the Open Ledger piece). Batches 1–45 shipped. Content
  dates run into 2027. **10 client-side tools** (the last two are the systemd hardening and nginx generators).
  **Mass content production is paused** — new work must be *different in kind* (see
  `notes/explore/SYNTHESIS.md`); the ~2-month observation window runs to ~2026-12-15.
- **Five "different in kind" pieces shipped (2026-10-15), all vision-verified:**
  `/open/` (the Open Ledger, build-time-computed numbers + a defect log); `request-ladder`
  (a real `curl -v` as a zero-JS CSS `animation-timeline: view()` timeline); `wire-protocol-bytes`
  (real EasyTier frames from ESPTier's own C encoder as a click-any-byte explorer);
  `bead-lens-lab` (DotLens3D's ray-tracing shader ported to WebGL2, interactive);
  `congestion-lab` (a 2D-canvas TCP congestion/bufferbloat simulation).
  All are `.mdx` articles importing an Astro component — the pipeline needed no changes.
  Interactive articles are the current shape; the home page has a "Start with these"
  highlights block pointing at them, and **`/labs/`** (bilingual) is the hub: each entry
  states what is real and what it cannot do, plus how they were verified.
  **Robustness/a11y conventions for interactive pieces**: render the first state
  server-side (no-JS crawlers — Baidu's is weak at JS — must see real content), add a
  `<noscript>` fallback with the conclusions in text for canvas widgets, and never create
  a long tab-stop run (the byte grid uses a roving tabindex + arrow keys: one tab stop).
- **The Open Ledger (first "different in kind" bet, 2026-10-15)**: `/open/` is a live
  audit page whose numbers are computed from the repo at build time (files, pairs, words,
  code blocks, the near-duplicate distribution, a real defect log), plus the companion
  article `the-open-ledger` written to the new rules. Exploration reports and the writing
  rules live in `notes/explore/` (start with `SYNTHESIS.md`).
- **Design layer shipped** (`theme.css`, the "engineering notebook" pass) — verified with
  a headless-Chromium screenshot → vision-subagent loop (measure ~78 CPL, AA contrast,
  equal-height cards, code chrome, CJK leading). Iterate visually with that loop.
- **Monetisation + search shipped**: `/support/` + `/uses/` (bilingual; affiliate slots are
  empty → they render as plain text, so there are no broken links yet), an off-by-default
  `AdSlot` (zero bytes until enabled), and client-side full-text search (Pagefind) at
  `/search/` + `/zh/search/` (index generated in `postbuild`). Fill `SUPPORT` in
  `SupportView.astro` and the `href`s in `UsesView.astro` once the affiliate/donation
  accounts exist.
  - **Ad path, verified 2026-10-15**: `AdSlot` was previously **imported nowhere**, so the
    manual unit would have rendered nothing even switched on (Auto ads *were* fine, since
    `adsbygoogle.js` is in `<head>` on every page). It is now placed in `PostLayout` after
    the article body. `ENABLED = false` keeps the build output byte-identical; a dry run
    with it set to `true` put a correct responsive unit on **530 article pages** (EN+ZH)
    and nothing on the home/tools pages. Flipping that one boolean (or the operator
    enabling Auto ads) is all that remains — plus the EEA/UK consent message.
- **Tools** (`/tools/`, **10** total, bilingual, zero server cost): IPv6 + IPv4 subnet
  calculators, number-base converter (bit editor), endianness visualizer (IEEE-754),
  CRC calculator (6 algorithms, verified against standard check values), chmod calculator,
  Base64/URL/Hex/HTML-entity encoder, cron explainer, and the **systemd hardening
  generator** (22 real directives, each with its honest cost; output checked with
  `systemd-analyze verify`), and the **nginx reverse-proxy generator** (output split into
  http/server because `limit_req_zone` & co. are illegal in a server block; all four presets
  checked with `nginx -t`, which caught an unclosed `location` block on the first try). Each links into the matching posts, and `PostLayout` now
  links back to them by tag. A component-usage audit (2026-10-15) found **no orphaned
  components** — `AdSlot` had been the only one, and it is now placed.
- **Static JSON API**: `/api/posts.json` (every post, both locales) + `/api/tags.json`
  (tags + counts), generated at build time. The sitemap filter now excludes machine
  endpoints (`/api/`, `*.xml`, `*.json`, `*.txt`) so only HTML pages are listed.
  **Full-site health check (2026-10-15)**: all **612 sitemap URLs return 200**, and every
  machine endpoint is valid (`/api/*.json` parse, `/rss.xml` + `/feed.json` in both
  locales, `/robots.txt`, `/ads.txt`, `/sitemap-index.xml`). Note `llms-full.txt` is
  ~7.9 MB (the whole corpus in one file) — intentional, and it is not in the sitemap.
  **Payload baseline**: one shared stylesheet (**22 KB**), page HTML 15–33 KB, and an
  interactive page adds a single component bundle (~10 KB) — no framework JS, no web
  fonts, so a full page load is ~40–65 KB. `dist/` is 102 MB, almost all of it OG cards
  and the Pagefind index.
  **Dependency posture (2026-10-15)**: **7 direct dependencies** (6 Astro plugins + the
  `astro` core, plus `pagefind` in dev), `npm audit` **0 vulnerabilities** at every level,
  and `npm outdated` reports nothing. Keep it that way — this is what makes the build fit
  in 981 MB and the payload stay tiny; add a dependency only for something that cannot be
  hand-written.
  **Internal linking (same check)**: **0 orphan pages**; the tool pages were the weakest
  (2 inbound links each) and are now 28–178 via the tag→tool block in `PostLayout`
  (`src/lib/tools.ts` + `RelatedTools.astro`).
- `notes/content-strategy.md` holds the topic backlog (v1 + v2) and channel strategy.
- `notes/hn-queue.md` = ranked HN submissions with ready titles/first comments
  (posting is manual: the operator's HN account is under probation).
- `notes/distribution-kit.md`, `notes/crosspost-kit.md`, `notes/backlink-targets.md`
  hold the channel playbooks and the backlink log.
- `crosspost/devto/` holds generated dev.to drafts (205 so far).

---

## 12. Security TODOs

- **Secret audit (2026-10-15): clean.** The repo mirrors publicly to GitHub, so I scanned
  the tracked files **and the full history** (133 commits, `git log -S` pickaxe) for key
  material. No API keys, no cloud key shapes (`AKID`/`AKIA`/`ghp_`/`github_pat_`/`AIza`),
  no `https://user:pass@` URLs. The only PEM-header matches are article *text* about what
  to look for when auditing firmware, and the only high-entropy strings are hash/digest
  examples (git SHAs, sha256, docker layer digests). The Tencent keys are referenced by
  path only, exactly as intended. Re-run this scan after any change that touches config.
- **Tencent Cloud API keys are hardcoded** in `/root/python/ssl_auto_download/ssl_auto_download.py`
  on TOWER and were exposed in an earlier session — **rotation is outstanding**.
- Never commit secrets; reference their location instead (this repo mirrors to GitHub).

---

## 13. Related projects (read-only unless told otherwise)

- **DotLens3D** — `/home/awinx/dev/active/DotLens3D` (the operator's project).
  A Python/PySide6 + moderngl **GPU per-pixel ray tracer** that forward-simulates a
  glass-bead-array lens (moiré magnification + parallax depth; the physics behind
  glass-bead 3D pictures). Has a detailed `spec.md`; **headless rendering works**:
  `PYTHONPATH=<dir> .venv/bin/python …` → `moderngl.create_context(standalone=True)` →
  `Renderer.render()` → PNG. Used as a blog subject; the operator says it will keep
  being updated, so revisit it.
- The dev box has other agent workspaces under `/home/awinx/dev/{active,labs,paused,running,sourced,tools}`
  — the operator grants full read access for exploration.

---

## 14. Maintaining this file

When something durable is learned, add it here in the same commit:
pipeline/deploy changes, new conventions, new gotchas, model/tooling changes, design
decisions, current counts, security items. Keep it **dense and factual**; delete stale
lines rather than letting them rot. This is the memory that survives context loss.

**Talking to the operator:** do **not** report work in chat — the operator will miss it.
Write anything worth sharing (progress, findings, requests) to **`留言.md`** at the repo
root, newest entry on top. Keep only genuinely operator-actionable items there.

**Who may write these files:** `AGENTS.md` and `留言.md` are maintained by the
**orchestrator only**. Drafting subagents must **never** create, edit, or overwrite
either one (a subagent once clobbered `留言.md` with its own status) — their only
outputs are their two article files.

---

## 15. Resources, budget, and the long-horizon plan

**Operator's principle (2026-10-14): slow, cheap experimentation is welcome.** Static
output has ~zero runtime cost, so we can afford to try things over months, measure, and
pivot. Do not optimise for a fast win; optimise for a cheap, reversible trial.

### Machines
| Name | What | Use it for |
|---|---|---|
| **TOWER** | public box, Ubuntu, **981 MB RAM** | serving the static site; light scheduled jobs only — **never** builds |
| **BOOK** | local dev box, Arch | all building, Docker labs, experiments |
| **EARTH** | big storage, Arch, mostly-on but not guaranteed | archives/datasets; jobs must be idempotent + resumable |
| **MAGIK** | Ryzen 7735H, 32 GB, RTX 4060, Arch, **on request** | GPU bursts: generated imagery, embeddings, heavy precompute |

### Model budget
- Drafting → the free `opencode-go` `*-free` ids (rotate them). Never the host `ollama`.
- Me (the orchestrator) → limited but rarely exhausted.
- **Advanced models: use sparingly** — a single session can drain the budget, after which
  we fall back to the operator's DeepSeek API and must then work **off-peak only**.

### The first small goal (operator)
**Cover the minimum spend: one domain + one minimal public VPS ≈ ¥160/year (~¥13/mo,
~$1.8/mo).** The opencode-go plan is *not* counted (used elsewhere). No hard metrics —
this is a low bar that should be easy to fill. Traffic is a *means*, not the end. If a
direction takes off, **scale the machine up**. The operator has delegated the "how"
entirely: I decide and direct the (free) models. Monetisation options + "static content
beyond articles" ideas live in `notes/next-horizon.md`.

**Ad network (operator's choice, 2026-10-15): Google AdSense.** `adsbygoogle.js` is in
`<head>` on every page (client `ca-pub-4702033324942872` → `ADSENSE_CLIENT` in
`consts.ts`), `public/ads.txt` is served, and `AdSlot.astro` holds a manual unit that
renders nothing until a slot id is pasted. **Operator still needs to**: verify the site in
the AdSense dashboard, enable Auto ads (or send a unit slot id), and enable a consent
message for EEA/UK traffic. Ads are the site's only third-party tracker, and `/support/`
+ `/about/` now disclose that.

### Plan (set by the operator)
- **Batch 45 is the last mass content batch.**
- Then **observe ~2 months** (to ~2026-12-15) on real analytics + GSC data.
- If the effect is poor, **change direction** — the blog is not the only possible output.
- Candidate directions and concrete "static content beyond articles" ideas live in
  **`notes/next-horizon.md`** (tools, data products, generated visuals, ZH-first).
- Set a reminder to **review analytics ~2026-12-15** and decide.
