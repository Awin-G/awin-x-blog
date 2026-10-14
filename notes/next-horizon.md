# Next horizon — after batch 45, observe, then decide

> Written 2026-10-14. This is the plan the operator set: **batch 45 is the last mass
> content batch. Then observe ~2 months. If the effect is poor, change direction.**
> Keep this file current; it is the strategic memory, not a status log (that is `留言.md`).

---

## 0. The first small goal (operator, 2026-10-14)

> "找到能在这样一个小机器上赚回机器本身的资金，维持我的虚拟组网" —
> find something that, on this small machine, **earns back the machine's own cost**, to
> sustain the operator's virtual networking (the EasyTier mesh / self-hosted stack).

**The number: ¥160/year (≈ ¥13/month, ≈ $1.8/month)** for one domain + one minimal VPS.
The opencode-go plan is not counted (used elsewhere). No hard metrics.

So the near-term objective is **not** "traffic for its own sake" — it is **a trickle of
revenue that clears ~¥160/year**. This is a *low* bar, which changes the plan:

- **One VPS-affiliate signup can cover a whole year** (typical payouts are $10–25). So the
  highest-leverage single action is: recommend one specific cheap VPS, honestly, with a
  referral link, in content that is already about exactly that (e.g.
  `/posts/choosing-a-vps/`, the self-hosting posts) plus a `/uses/` page.
- One small artifact sale (~¥30) × 6, or one or two donations, also clears it.
- Ad networks (Ethical Ads etc.) need far more traffic than this bar requires — keep them
  as a later option, not the plan.

The original strategy is also **broad exploration across many directions** — the blog is
ONE bet, not the only one. Keep several cheap bets alive, and:

> "如果某个方向火了，就可以考虑扩容机器了" — **if a direction takes off, scale the
> machine up.** Cheap trials first; add resources only once a bet is winning.

### Monetisation options, ranked for a tiny, static, technical site

| Option | Fit | Notes |
|---|---|---|
| **VPS / hosting affiliate** | ★★★ | Our content is literally "self-hosting on a cheap box". Vultr, DigitalOcean, Linode/Akamai, RackNerd, Tencent/Aliyun (CN). Also domain registrars. |
| **Hardware affiliate** | ★★★ | ESP32/embedded + homelab readers buy boards, sensors, test gear, mini-PCs. Amazon Associates / AliExpress / Taobao (CN). |
| **Ethical Ads / Carbon** | ★★ | Text-only, developer-focused, privacy-friendly — the only ad style that fits the "engineering notebook" design. Needs an application + some traffic. |
| **Donations** | ★★ | GitHub Sponsors, Ko-fi, 爱发电, Buy Me a Coffee. A `/support/` page. Fits the "an AI runs this site" story. |
| **Sell an artifact** | ★★ | A paid ebook ("self-hosting on a $5 box"), a template, a paid dataset, or **print-on-demand procedural art** (MAGIK GPU). |
| **Sponsorship** | ★ | Needs audience; later. |
| **DotLens3D / project sponsorship** | ★ | If that project gains traction, GitHub Sponsors there. |

**Cheap, reversible plumbing to add now** (before traffic, so revenue can start the day
it arrives): a `/support/` page; an honest "hosting & gear I actually use" page with
affiliate links (marked `rel="sponsored"`); an **ads slot component that is off by
default and degrades to nothing** (zero perf/CLS cost until enabled).

**Do not** trade the design/readability for ads — text-only developer ads only, and only
if the numbers justify it.

**Update 2026-10-15:** the operator chose **Google AdSense** — it is now live (script in
`<head>`, `ads.txt`, honest disclosure on `/support/`). See `AGENTS.md` §15 for the
outstanding dashboard steps (verify the site, enable Auto ads, enable a consent message).
The affiliate and donation paths above still apply; AdSense is the baseline that should
clear ¥160/year on its own.

### Operator's assessment (2026-10-15) — the important one

> "我预感这个博客不会有太多流量，因为它看起来没有什么独特之处，信息也扁平，冗长无趣，
> 不会有太大的吸引力。派发子代理去探索吧"

Read plainly: **more articles of the same shape will not fix this.** 260 articles that are
competent, reproducible and *interchangeable* — the same "topic → real experiment →
honest conclusion" shape, 1300–1800 words, one SVG, no voice, no story, no interaction,
no strong opinion. Volume without differentiation is invisible.

So the next phase is **exploration, not production**:

- Diagnose *why* it reads flat (structure, voice, length, hooks, visuals).
- Find content **forms** that are hard to copy: interactive explainers, visual/animated
  explanations, unique datasets, project deep-dives with real artefacts.
- Find the **angle only this setup has**: an AI that runs its own infrastructure, plus the
  operator's real work (EasyTier/mesh, the ESP32 protocol reimplementation, DotLens3D
  optics, the tiny public box).
- Subagent findings land in `notes/explore/*.md`.

**Rule for this phase:** a new post must be *different in kind*, not just a new topic. If
any competent engineer could have written it about any topic, it does not count.

---

## 1. The decision

- Ship batch 45, then **pause mass content production**.
- **Observe ~2 months** (to ~mid-December 2026) with real data, then decide:
  keep going, change topic focus, or change the *form* of the product.
- The blog is not the only possible output. See §4.

## 2. What to measure during the observation window

Pull from GoAccess (`/var/www/stats/report.json` on TOWER) + GSC (once verified):

- **Organic search clicks/impressions** (GSC) — the real signal; IndexNow ≠ indexation.
- **Unique visitors & requests** per week; **EN vs ZH split**.
- **Top landing pages** and **which topics** actually get read (the ESP32 post led early).
- **Referrers**: is anything besides crawlers + Baidu? (GitHub, HN, dev.to, Bing…)
- **Indexed-page count** (site: queries / GSC coverage) — are 500+ pages indexed?
- **Bing/Baidu** trends (Baidu already sent `ziyuan.baidu.com` referrals).

Decision rule (proposal): if organic clicks are still ~0 and unique visitors are flat
after 8 weeks, the bottleneck is **discovery/authority, not volume** → pivot (§5).

## 3. Resource inventory (constraints shape what is worth building)

| Resource | What it is | Best used for |
|---|---|---|
| **TOWER** | public box, Ubuntu, **981 MB RAM**, 1 core-ish, always on | serving the static site; *light* scheduled jobs (crawl/collect with strict limits); NOT builds |
| **BOOK** | the local dev box (Arch), decent | all building, experiments, Docker labs |
| **EARTH** | big-storage box (Arch), mostly-on but **not guaranteed** | archives, datasets, periodic collection history; must be idempotent/resumable |
| **MAGIK** | laptop: Ryzen 7735H, 32 GB, **RTX 4060**, Arch, **on request** | GPU bursts: generated imagery, embeddings, heavy precompute |
| **Models** | free `opencode-go` `*-free` ids for drafting; me (limited but rarely exhausted); **advanced models sparingly** (one session can drain the budget → then the operator's DeepSeek API → then off-peak only) | drafting = free models; reserve advanced/vision for genuinely visual or high-value work |

**Budget rule:** default to free models; do not spend advanced models on routine
drafting. If the budget is gone, work off-peak.

## 4. Ideas: static web content beyond "more articles"

Static output has ~zero *runtime* cost, so the real constraints are **build-time**,
**unique data**, and **what earns links** (and, per §0, **what can earn a little money**).
Ranked by value/effort:

### A. Link magnets that cost nothing to serve (do first)
1. **Client-side tools hub** (`/tools/`) — expand it: chmod, cron explainer, CIDR/子网,
   JWT decoder, hash, base64, UUID, timestamp, diff, regex tester, colour/SVG helpers.
   Pure JS/WASM = no server, and tools earn links + repeat visits.
2. **Client-side search** over the whole blog (Pagefind / lunr) — no server, better UX,
   and a reason to stay.
3. **ZH-first quick references** (Linux/networking/命令速查) — Baidu already refers
   traffic; Chinese readers are underserved for this kind of thing.
4. **Pre-rendered JSON endpoints** (`/api/*.json`) for our own data (tag index, content
   index, datasets) — a static site can be an API; cacheable, linkable, no server.
5. **Revenue plumbing** (§0): `/support/`, an honest "gear & hosting I use" page, an
   off-by-default ads slot.

### B. Data products (need TOWER/EARTH, on a schedule)
6. **"State of X" datasets**: crawl a *fixed* list of sites and publish a static report +
   JSON — e.g. security-header/HSTS adoption, TLS config, `robots.txt`/`llms.txt`
   adoption, DNS/HTTP3 support. TOWER crawls lightly; EARTH keeps history → trend pages.
7. **Archive/mirror** (EARTH's storage): a curated, licence-permitting mirror of
   at-risk docs, with a static index. "Link rot" is a real problem worth solving.
8. **Historical snapshots**: e.g. monthly snapshots of a few open datasets rendered as
   static charts.

### C. Generated/visual (MAGIK GPU, in bursts)
9. **Procedural visual gallery**: math/optics/geometry renders (DotLens3D-adjacent),
   generative art, plots — highly shareable, static, and we already have the optics story.
10. **Precomputed heavy artifacts**: embeddings for semantic search, a big prebuilt search
    index, static "answer" pages generated offline.
11. **WASM demos** (static, powerful): ffmpeg-wasm, sqlite-wasm, a tiny in-browser
    sandbox — each is a standalone linkable artifact.

### D. Make the blog itself stickier (cheap, do alongside A)
12. Series/learning paths ("start here" already exists — deepen it).
13. A proper `/now` and `/uses` page (Simon Willison-style) — humans and crawlers like it,
    and `/uses` is where affiliate links live naturally.
14. Better internal linking surfaced from `notes/content-index.md` (we have the graph).

## 5. If we pivot: candidate directions

- **Tools-first**: the blog becomes the marketing for a set of client-side tools.
- **Data-first**: the "State of X" datasets become the product (linkable, citable).
- **Visual-first**: generated/explainer visuals (needs MAGIK bursts; high shareability).
- **ZH-first**: lean into Chinese search (Baidu) where competition is thinner.
- **Aggregation**: curated, human-written "best of" pages over our own 250+ articles.

## 6. Immediate next steps

1. Finish + ship **batch 44** (running) and **batch 45** (the last content batch).
2. Add the **revenue plumbing** (§0) + **Pagefind search** + 4–6 new client-side tools.
3. Get **GSC verified** (operator action) so §2 has real data.
4. Draft the **"State of X" crawler** design (TOWER-safe limits) for the observation window.
5. Set a reminder to **review analytics on ~2026-12-15** and decide.
