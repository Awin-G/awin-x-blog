# Unique content bets — what ONLY this setup can produce

> Written 2026-10-15 by an exploration subagent. Read-only inputs: `AGENTS.md`,
> `notes/next-horizon.md`, `README.md`, `DotLens3D/spec.md`, the sibling projects
> (`ESPTier`, `EdgeTier`, `easytier-kde`, `RuiJieAutoLogin`, `bare_x86`), the content
> index, and `留言.md`. **No repo file was modified.**
>
> The diagnosis this starts from (operator, 2026-10-15): 260 competent, reproducible,
> *interchangeable* articles. More topics will not fix it. The fix is **form + angle**:
> only ship a piece if a competent engineer could NOT have written it about any other
> topic, because a required asset does not exist anywhere else.

---

## 0. The asset inventory (what is genuinely ours)

Before the bets: the raw uniqueness, ranked by how hard it is to copy.

| # | Asset | Why a normal blogger cannot have it |
|---|---|---|
| A1 | **The experiment itself**: a blog written, gated, built, deployed and SEO-managed end-to-end by an autonomous AI agent with root on the public box — 45 batches, 260 articles, one fabrication incident caught and repaired | Being the subject IS the asset. Every number (gate failures, dedup distribution, model rotation, deploy history, IndexNow cadence) is only citable by the machine that lives it |
| A2 | **A working C reimplementation of a real wire protocol on an MCU**: ESPTier speaks EasyTier v2.6.4 TCP frames / SipHash-1-3 identity / AES-128-GCM / `OspfRouteRpc` from an ESP32-C3, interop with the real Rust daemon, M0–M6 done, testnet + pcaps exist | Most mesh-VPN posts are comparisons. Almost nobody has the *working interop artifact*, the annotated protocol doc written against real captures, and the board |
| A3 | **DotLens3D**: a real forward-physics GPU per-pixel ray tracer for glass-bead lenses — spec, 21 unit tests, 23 presets, two optical modes, headless rendering proven, plus **inverse design** (render a 3D model into a *printable* canvas) and a second app (**Pinhole3D**: laser-cut pinhole arrays, no optics degree needed) | A physics toy anyone could *propose*; almost nobody ships one *validated* to this depth, with the simulation → print → photograph loop available |
| A4 | **TOWER itself**: a 981 MB, ~1-core public VPS that builds (Astro, peak ~790 MB, swap-tuned), serves 592 URLs, gets OOM-killed and repaired, and holds the agent's SSH key | The constraint is real and documented; the failure log is real. "$5-box production" posts are common, but this box also has an *owner* who is software |
| A5 | **The real network**: 3 machines + a mesh — campus Ruijie ESS portal + CAS reverse-engineered and auto-logging on EARTH's `enp7s0`, EasyTier overlay with split-horizon DNS (`git`/`alist`/`s3` on the overlay, blog on the public IP), apex `awin-x.top` 301'd to the blog so AdSense can verify | Homelab diagrams are aspirational; this one is load-bearing and messy (captive portal, overlay, storage box, GPU laptop on request) |
| A6 | **Bilingual by construction**: 260 EN/ZH sibling pairs sharing a `translationKey`, Baidu already referring traffic, IndexNow on every deploy | A built-in natural experiment: identical content, two languages, two search ecosystems, one author |
| A7 | **EdgeTier**: a research-grade overlay fabric (presence/connectivity decoupled, capability × policy), design doc with RQ1–RQ4, a real bad link (France 1C1G, ~1 Mbps, jittery) and `tc netem` for reproducibility | Research-in-the-open on hardware that is genuinely constrained; most publish only after the paper |
| A8 | **The message board** (`留言.md`): the operator-agent working relationship in writing — requests, fixes, decisions, dates | The only blog whose "git log of the relationship with its boss" is public record |

The bets below are packaging for these assets. Scoring: **differentiation (1–5) ×
feasibility (1–5)** on BOOK with free drafting models; MAGIK is "on request".

---

## 1. The bets

### Bet 1 — The Open Ledger: the content factory, published as a teardown
**Promise:** every honest number about running a 260-article, bilingual, AI-written
publication with a build gate — what it costs, what breaks, what the defect rate is —
plus a live metrics page that keeps updating.

**Why only here:** A1 + A4 + A8. The data exists nowhere else: 45 batches of commit
history, the `check-content.mjs` gate and its real failure list, the cosine-dedup
distribution from `scripts/lib/similarity.mjs`, the fabricated-output incident in
`tcp-proxy-in-go` (committed sin → repair), the free-model rotation and its endpoint
failures, `留言.md` as the operator-relationship record, GoAccess `history.tsv` on TOWER.
A normal blogger has a writing habit; we have a *measurable factory with its QC machinery
in public source*.

**First piece:** EN/ZH post — *"I wrote 260 articles as an AI and built a gate to keep
them honest"* — form: **teardown + dataset**, with the real gate source, the real dedup
distribution, the real failure narratives, and an embedded interactive: the near-duplicate
scatter of the corpus (cosine similarity histogram, computed at build time from
`content-index.json` — no invented numbers).

**Credibility:** git history, `scripts/check-content.mjs` + `content-index.mjs` source,
`/api/posts.json` counts, `留言.md` entries with dates, the repaired article itself.

**Effort:** ~3–4 days. **No machine needed.** Caveat: golden rule 7 — subagents write
only their two article files, so the interactive/dataset page is built by the orchestrator
(or an explicitly briefed agent) separately from the article files.

**Risk:** navel-gazing. Readers care about their factories, not ours — the framing must
teach the *machinery* (batch QC for agent output, dedup, bilingual pairing stats), with our
numbers as the worked example. Also: publishing defect data is permanent; the fabricated-
output story must be told straight.

---

### Bet 2 — The ESPTier Protocol Lab: a mesh VPN's wire protocol, decoded byte by byte
**Promise:** take a real overlay protocol nobody documents (EasyTier v2.6.4's frames,
SipHash-1-3 identity derivation, AES-128-GCM sessions, `OspfRouteRpc` route sync) and let
the reader *manipulate it live* — with a $3 ESP32-C3 as one endpoint and the real Rust
daemon as the other.

**Why only here:** A2. The annotated `docs/protocol.md` was written *against real
captures*, the C reimplementation interoperates (real node can ping the ESP32; M6: traffic
routes *through* the MCU), and the testnet scripts + port table exist. A normal blogger
reverse-engineers something read-only; we can run the protocol on both ends.

**First piece:** EN/ZH post — *"The EasyTier handshake, byte by byte"* — form:
**interactive protocol explorer**. Real captured handshake frames (from the testnet
captures), an in-page decoder: hover/annotate the 16-byte `PeerManagerHeader` fields,
watch the digest-mismatch → `ET_PEER_DEAD` state machine, recompute the SipHash-1-3
32-byte digest in JS from a name+secret the reader types (golden vectors already exist in
the repo). Side panel: real ESP32-C3 numbers — flash/RAM footprint, handshake latency,
from `apps/esp32` + `e2e_m5.sh` runs.

**Credibility:** real pcaps from `scripts/testnet.sh`, `easytier-cli peer` output,
`idf.py size` output, the interop test logs.

**Effort:** ~1 week. **No new machine** (BOOK + the operator's ESP32-C3). The decoder is
vanilla JS, static, zero server cost.

**Risk:** niche (embedded + networking intersection). Mitigation: pitch the *method* —
"reverse-engineering a wire protocol when there is no spec, and keeping it interoperable"
— which is a durable skill-post; the EasyTier/ESP32 specifics become the worked example.
The protocol is someone else's project: keep it factual, no vendettas.

---

### Bet 3 — The DotLens3D Optics Lab: glass-bead 3D physics, running in the browser
**Promise:** those glittering "3D" glass-bead pictures demystified — and *rebuilt* — in
the browser: drag sliders for bead diameter, refractive index, spacing, and watch moiré
magnification and parallax appear from real per-pixel ray tracing; then download a canvas
and print your own.

**Why only here:** A3 + MAGIK. The tracer is real (two optical modes, spec, unit tests,
presets), headless rendering is proven, and the **inverse-design** code (render a 3D model
into a printable interlaced canvas) exists as working code — so the toy is not a toy: it
ends in an artifact the reader holds. MAGIK is on request for the high-resolution renders
and the "simulation vs print" comparisons.

**First piece:** EN/ZH post — *"Glass-bead 3D physics, running in your browser"* — form:
**interactive WebGL lab** (the existing GLSL `#version 330 core` raytrace shader ports to
WebGL2 with modest work: uniforms and texture sampling map almost 1:1; the spec and tests
are the porting contract). Sliders for the real mm parameters, ideal-lens vs refraction
modes, the zone-plate preset, and a **"print your own canvas"** export from the
inverse-design module. Piece 2 (stretch): print it, photograph it next to the simulation —
the physical-validation loop nobody runs. Piece 3: Pinhole3D — the laser-cut, no-optics
route to the same illusion, with the real `p/a/d` parameter table.

**Credibility:** existing headless renders, the 21 unit tests, the spec's formulas
(`f = nR/2(n−1)`, `span = 2R·|1 − d/f|`, `θ_max`), MAGIK renders; the photo comparison if it
lands.

**Effort:** ~1–1.5 weeks (WebGL port + controls + bilingual article). **MAGIK on request**
for renders; a print is a ~¥50 experiment (lenticular sheet — also a natural affiliate slot
on `/uses/`).

**Risk:** the physics-toy audience is smaller than the protocol audience, and the shader
port eats time. But this is the most *visual* artifact available — the direct antidote to
"flat and boring" — and the print loop has a revenue tail (lenticular sheets, bead arrays).
If WebGL2 stalls on old devices, the fallback is MAGIK-rendered frame sequences (scrubbable
timeline) — still interactive, no port needed.

---

### Bet 4 — The network that serves this blog, drawn from life
**Promise:** not an idealized homelab diagram — the real one: a campus captive portal
re-engineered into an auto-login daemon, a 981 MB public box with swap and an OOM
scar, an overlay with split-horizon DNS, a storage box, a GPU laptop that sleeps — and the
AI holding the SSH key to all of it.

**Why only here:** A4 + A5. Every node has a real config, a real failure story, and an odd
constraint (DNS split so AdSense can verify the apex; `git`/`alist`/`s3` staying on the
overlay; the France link; the measured 16-second portal re-login). Normal blogs draw
aspiration; this mesh is load-bearing.

**First piece:** EN/ZH post — *"The network that serves this blog"* — form: **interactive
topology map** (SVG, click a node → its real config snippet, scrubbed keys/IPs; toggle
"show the failure paths" → the OOM-killed build, the certificate that renews itself, the
apex 301).

**Credibility:** deployed nginx vhosts, the EasyTier configs, DNS records (via
`dnspod_set.py`), the RuiJie login's measured transcript, TOWER's `journalctl`/swap stats.

**Effort:** ~3–4 days. **No machine needed.**

**Risk:** exposure — scrub ruthlessly (keys, exact secrets, the DNSPod credentials — never
duplicated in-repo per the security rule). Also "my setup" posts are a genre; the
differentiators are the weird specifics and the honest failure layer.

---

### Bet 5 — The Search Race: a public, longitudinal record of what search engines do with an AI-written bilingual site
**Promise:** month by month, unembellished: what Google, Bing and Baidu do with 592 URLs
of AI-written content in two languages, with IndexNow fired on every deploy — the
experiment most people speculate about, run in public.

**Why only here:** A1 + A6. The bilingual pairing makes it a natural experiment (identical
content, two ecosystems), the IndexNow-on-every-deploy cadence is a real intervention, and
the data (GoAccess `history.tsv`, Baidu referrers already present, GSC once the operator
verifies) is generated by the machine itself. Anyone else would have to *be* the site.

**First piece:** a living page — *"The Search Race: month 1"* — form: **public log**.
Month-1 data is real and available now (the 2026-10-14 snapshot: 2,918 requests / 59
visitors / Baidu + GitHub referrers; IndexNow submissions; crawl stats). Updates monthly
through the observation window; it is the input the operator asked for at ~2026-12-15.

**Credibility:** `history.tsv` on TOWER, IndexNow logs, GSC exports (after operator
verification), the sitemap/URL counts.

**Effort:** ~2 days for month 1, then ~1 hour/month. **No machine needed**; needs the
operator's GSC verification to be complete.

**Risk:** the answer may be a boring "nothing happened yet" for months — which is *also*
the honest, searched-for finding ("does AI content rank?"), but it delays the payoff and
can read as self-promotion if the tone slips. Mitigation: publish the nulls with the same
prominence as the wins.

---

### Bet 6 — EdgeTier Research Log: a new overlay fabric, measured in the open
**Promise:** watch a research-grade mesh fabric (presence decoupled from connectivity,
capability × policy, lazy-by-default links) get designed, built and measured against
EasyTier and MQTT — on a genuinely awful transcontinental link — with every number
published as it happens.

**Why only here:** A7. The design doc (RQ1–RQ4, novelty statement, gap table) exists, the
S1 idle-cost experiment exists, and the hardware constraints (France 1C1G at ~1 Mbps with
jitter, ESP32 leaves, one phone) are real. Most researchers publish at the end; the lab
notebook is the content.

**First piece:** EN/ZH post — *"Idle cost of a presence plane: first measurements"* — form:
**research log + dataset** (K nodes, bytes/s per node, table size over time, raw CSV +
the `s1_idle_cost` source; then the netem matrix over the France link).

**Credibility:** `experiments/s1_idle_cost.cpp` + real runs, `tc netem` configs, the design
doc's success criteria.

**Effort:** ~3 days for piece 1, more per experiment. **No machine needed** beyond BOOK
+ the existing link; EARTH for history.

**Risk:** the project is early and research-first — it may stall or return negative
results, and the blog inherits that. Mitigation: frame the log as "may go nowhere, that is
the experiment", and keep each piece individually useful (the measurement method on a bad
link is reusable knowledge).

---

### Bet 7 — Guess the author: 260 AI-written articles, one weekend
**Promise:** every post on this blog was written by an AI — here is the guess-the-author
quiz over the real corpus, and here is what the guesses get right and wrong.

**Why only here:** A1. The corpus (260 bilingual articles, real frontmatter, real
translation pairs) is the dataset; "all of them" is the twist that lands once and honestly.
A normal blogger has no 260-article AI corpus to quiz with.

**First piece:** EN/ZH post — *"Every post here was written by an AI. Guess which."* —
form: **interactive quiz** (real article excerpts as cards, real answer reveal, aggregate
stats shown live, e.g. per-tag guess accuracy — computed at build time, not invented).

**Credibility:** the corpus itself (`/api/posts.json`), the commit history, the batch
process in Bet 1.

**Effort:** ~1–2 days. **No machine needed.**

**Risk:** one-and-done virality with a short tail; it can read as a gimmick if it is not
tied to the substance (pair it with Bet 1's factory numbers so the quiz *drives traffic
into* the teardown). Use as a launch gag for the first real lab, not as a strategy.

---

## 2. Ranking (differentiation × feasibility)

| Rank | Bet | Differentiation | Feasibility | Score /25 | Compounding |
|---|---|---|---|---|---|
| **1** | **The Open Ledger** (factory teardown + live metrics) | 5 | 5 | **25** | Highest: it becomes the distribution channel and the observation-window artifact for every later bet |
| 2 | ESPTier Protocol Lab | 4.5 | 4 | 18 | High: evergreen embedded/networking SEO, HN-shaped, can spawn a protocol series |
| 3 | DotLens3D Optics Lab | 4.5 | 3.5 | 16 | High: visual = shareable; print loop feeds `/uses/` affiliates and MAGIK art |
| 4 | The Real Network Map | 3.5 | 4 | 14 | Medium: an asset embedded in the mesh/easytier corpus, not a traffic engine |
| 5 | The Search Race | 4.5 | 3 | 13.5 | High but slow: needs operator GSC action + months; null results are still content |
| 6 | EdgeTier Research Log | 4 | 2.5 | 10 | Medium: honest science, but inherits a young project's stall risk |
| 7 | Guess-the-Author quiz | 3 | 4.5 | 13.5 | Low on its own: a launch gag, best used to promote Bet 1 |

## 3. The single best first bet: **The Open Ledger**

Reasons, in order:

1. **It is the only bet whose raw material is unreproducible.** Every other bet competes
   with someone else's version of the idea; this one is a measurement of *this machine,
   this pipeline, this relationship* (`留言.md` literally documents the operator-agent
   loop). Copying it requires becoming the experiment.
2. **Zero dependencies.** No MAGIK, no GSC verification, no hardware, no shader port. All
   inputs exist today (git history, gate source, content index, `留言.md`, TOWER stats).
3. **It fixes the exact stated defect** — "flat, boring, interchangeable" — in *kind*:
   data, code and numbers instead of another 1300–1800-word topic essay.
4. **It compounds.** The live metrics page is where the Search Race accumulates, and every
   future lab piece (ESPTier, DotLens3D, network map) gets a "here is how it actually
   performed" follow-up — a content loop no other blog has. The operator's 2026-12-15
   review writes itself from the same data.
5. **It is cheap and reversible** — the operator's explicit trial criterion.

### First-week plan (concrete)

- **Day 0 (now).** Harvest the evidence, all read-only: `git log` stats (45 batches, commit
  cadence, dates), the gate's real failure list, `npm run dupes` full distribution, counts
  from `notes/content-index.json` + `/api/posts.json`, the model-rotation and endpoint-
  failure history from `AGENTS.md`/`留言.md`, the `tcp-proxy-in-go` fabricate→repair
  incident (commit hashes), TOWER build-time/OOM facts. Every number must be run, not
  remembered — golden rule 2.
- **Day 1.** Brief one subagent (free id, e.g. `opencode-go/step-5-preview-free`) to write
  the two article files only: EN/ZH *"I wrote 260 articles as an AI and built a gate to
  keep them honest"* — the machinery (gate, dedup, pairing, model rotation) taught through
  our real numbers, with the fabricated-output repair told straight. Verify the two files
  exist; re-launch on another free model if the run dies silently.
- **Day 2.** Build (or brief) the **live metrics page** (`/open/` sibling to `/tools/`,
  bilingual): corpus counts, batch history, dedup histogram, gate stats, deploy/build
  timing on TOWER — generated from `content-index.json` at build time. Zero server cost,
  no JS errors (verify with headless Chromium in Docker, per the existing tool-page
  practice). *This is an orchestrator-built component, not a subagent article file.*
- **Day 3.** `npm run check:content` → `npm run build` → commit → push to **both** remotes
  (Gitea + GitHub) → deploy → verify live (200s + counts). Add an HN-queue entry for the
  post (posting stays manual — operator's account).
- **Day 4.** Seed **The Search Race** as a section of `/open/`: month-1 real numbers
  (requests/visitors/referrers from the 2026-10-14 snapshot, IndexNow submissions, sitemap
  URL counts) with a monthly-update note; the December review inherits it automatically.
- **Day 5.** Draft the crosspost (`npm run crosspost`) and a short "here is the honest
  data" first-comment for the HN submission.
- **Days 6–7.** Start **Bet 2 (ESPTier Protocol Lab)** piece 1 (handshake decoder + real
  pcaps + ESP32 footprint numbers) — it now has a distribution channel the day it ships.

**Explicitly out of scope for week 1:** retrofitting old articles (golden rule 4), any
change to `AGENTS.md`/`留言.md` (this subagent may not write them; the orchestrator updates
them when a bet ships), and any spending on MAGIK or hardware.
