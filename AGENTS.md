# AGENTS.md — durable project memory

> **Purpose.** This file is the long-term memory for whoever/whatever works on this
> blog (human or agent). Context gets compressed and details get lost; this file is
> the thing that survives. **Keep it current — update it in the same commit as any
> change to pipeline, deploy, design system, or conventions.**
>
> Last updated: 2026-10-14 (batch 43 shipped; content index + dedup/similarity system
> in the content gate; "engineering notebook" design layer shipped and vision-verified;
> DotLens3D article written by the vision model; deploy OOM fixed with swap +
> incremental OG cache; operator message board is `留言.md`).

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
  pages/                        # routes: /, /posts, /tags, /tools, /about, /start, 404
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
- **OG cards are incremental**: `scripts/og.mjs` keeps `public/og/.manifest.json`
  (slug→hash) and only re-renders changed cards. `public/og/` is gitignored so it
  survives the deploy's `git clean`. Don't revert this to "wipe + render all 400".

---

## 8. Hosts, DNS, analytics

- **DNS**: Tencent DNSPod, automated via `deploy/tools/dnspod_set.py`. Apex `awin-x.top`
  → internal overlay IP `10.126.126.1` (not publicly reachable); `www`/`blog` →
  `88.218.79.95`.
- **Analytics**: server-side **GoAccess** over nginx logs at
  **https://stats.awin-x.top/** (basic auth; credentials are in the deploy scripts —
  **not** duplicated here because this repo is mirrored to GitHub).
  - GoAccess 1.3 needs `$HOME` set (silent-failure fix) and **ignores `TZ`**, so logs are
    converted to **China time (+0800)** before parsing. No `--ignore-crawlers`.
  - Use this data to steer topics and (over months) the design (§9).
- **Verification files** live: Google (DNS TXT), Bing (`BingSiteAuth.xml`),
  Baidu (`baidu_verify_codeva-...html`).
- **Indexing**: Google crawls + reads the sitemap but hasn't indexed yet; GSC "Verify"
  by the operator is the outstanding action. IndexNow is submitted on every deploy.

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
- **Vision**: this agent is text-only; use the `vision` skill / vision subagents to read
  images (per the injected vision note, the chosen model is `deepseek/deepseek-flash`).

---

## 11. Current state

- **248 articles / 496 posts / 555 pages** (after batch 43). Batches 1–43 shipped.
  Content dates run into 2027.
- **Design layer shipped** (`theme.css`, the "engineering notebook" pass) — verified with
  a headless-Chromium screenshot → vision-subagent loop (measure ~78 CPL, AA contrast,
  equal-height cards, code chrome, CJK leading). Iterate visually with that loop.
- `notes/content-strategy.md` holds the topic backlog (v1 + v2) and channel strategy.
- `notes/hn-queue.md` = ranked HN submissions with ready titles/first comments
  (posting is manual: the operator's HN account is under probation).
- `notes/distribution-kit.md`, `notes/crosspost-kit.md`, `notes/backlink-targets.md`
  hold the channel playbooks and the backlink log.
- `crosspost/devto/` holds generated dev.to drafts (205 so far).

---

## 12. Security TODOs

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
**Earn back the public box's own cost** to sustain the operator's virtual networking
(EasyTier mesh). Traffic is a *means*, not the end. If a direction takes off, **scale the
machine up**. Monetisation options + "static content beyond articles" ideas live in
`notes/next-horizon.md`.

### Plan (set by the operator)
- **Batch 45 is the last mass content batch.**
- Then **observe ~2 months** (to ~2026-12-15) on real analytics + GSC data.
- If the effect is poor, **change direction** — the blog is not the only possible output.
- Candidate directions and concrete "static content beyond articles" ideas live in
  **`notes/next-horizon.md`** (tools, data products, generated visuals, ZH-first).
- Set a reminder to **review analytics ~2026-12-15** and decide.
